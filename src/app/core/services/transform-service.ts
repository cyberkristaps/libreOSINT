import { Injectable, inject, signal } from '@angular/core';
import { Entity, EntityType, JsonValue } from '../models/entity';
import { TransformManifestEntry, TransformResponse } from '../models/transform';
import { ConsoleLog } from './console-log';
import { GraphTools, IngestResult } from './graph-tools';
import { GraphStore } from './graph-store';
import { BridgeError, TauriBridge } from './tauri-bridge';
import { NetworkSettings } from './network-settings';

let jobCounter = 0;
export const newJobId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(jobCounter++).toString(36)}`;

/** Registered transforms + running them (desktop only), with stderr streamed to the console. */
@Injectable({ providedIn: 'root' })
export class TransformService {
  private readonly bridge = inject(TauriBridge);
  private readonly log = inject(ConsoleLog);
  private readonly store = inject(GraphStore);
  private readonly tools = inject(GraphTools);
  private readonly network = inject(NetworkSettings);

  readonly transforms = signal<TransformManifestEntry[]>([]);
  readonly available = this.bridge.isTauri;
  private loaded?: Promise<void>;
  /** stderr lines already shown live, per running job, so `messages` don't repeat them. */
  private readonly streamed = new Map<string, Set<string>>();

  constructor() {
    void this.bridge.onTransformLog((e) => {
      this.streamed.get(e.job_id)?.add(stripLevel(e.line));
      this.log.log(levelOf(e.line), e.transform_id, stripLevel(e.line));
    });
  }

  ensureLoaded(): Promise<void> {
    this.loaded ??= this.bridge
      .transformList()
      .then((ts) => this.transforms.set(ts))
      .catch((err) => this.log.log('error', 'transforms', `Could not load transforms: ${(err as Error).message}`));
    return this.loaded;
  }

  forType(type: EntityType): TransformManifestEntry[] {
    return this.transforms().filter((t) => t.input_types.includes(type));
  }

  /** Run a transform against a value (not necessarily on the graph). */
  async run(
    transformId: string,
    input: { id?: string; type: EntityType; value: string; properties?: Record<string, JsonValue> },
    opts: { jobId?: string; params?: Record<string, JsonValue> } = {},
  ): Promise<TransformResponse> {
    const jobId = opts.jobId ?? newJobId('t');
    if (this.network.missingUrl()) {
      const message = 'Proxy mode is on but no proxy URL is set. Enter one in Settings, or switch to Direct.';
      this.log.log('error', transformId, message);
      throw new BridgeError('invalid_input', message);
    }
    const proxy = this.network.proxy();
    this.log.log('info', transformId, `▶ ${input.type} ${input.value}${proxy ? ` (via ${this.network.badge()})` : ''}`);
    const started = performance.now();
    const shown = new Set<string>();
    this.streamed.set(jobId, shown);
    try {
      const res = await this.bridge.transformRun(
        jobId,
        transformId,
        { id: input.id ?? '', type: input.type, value: input.value, properties: input.properties ?? {} },
        opts.params,
        proxy,
      );
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      // Warnings a transform only put in its JSON `messages` (not on stderr) would otherwise go unseen.
      for (const m of res.messages ?? []) {
        if ((m.level === 'warn' || m.level === 'error') && !shown.has(m.text)) this.log.log(m.level, transformId, m.text);
      }
      this.log.log('info', transformId, `✓ ${res.entities.length} result(s) in ${secs}s`);
      return res;
    } catch (err) {
      const e = err as BridgeError;
      this.log.log(e.kind === 'cancelled' ? 'warn' : 'error', transformId, e.kind === 'cancelled' ? 'cancelled' : e.message);
      throw err;
    } finally {
      this.streamed.delete(jobId);
    }
  }

  /** Manual "Run lookup" from the context menu: run and add the results to the graph. */
  async runOnEntity(transformId: string, entity: Entity): Promise<IngestResult> {
    const res = await this.run(transformId, entity);
    const r = this.tools.ingestTransform(entity.id, transformId, res);
    this.log.log('info', transformId, `Added ${r.created} new, merged ${r.merged}, ${r.edges} link(s)`);
    this.store.select(entity.id);
    return r;
  }
}

function levelOf(line: string): 'debug' | 'info' | 'warn' | 'error' {
  const m = /^\[(debug|info|warn|error)\]/.exec(line);
  return (m?.[1] as 'debug' | 'info' | 'warn' | 'error') ?? 'info';
}

function stripLevel(line: string): string {
  return line.replace(/^\[(debug|info|warn|error)\]\s*/, '');
}
