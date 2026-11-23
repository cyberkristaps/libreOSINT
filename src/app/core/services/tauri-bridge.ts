import { Injectable } from '@angular/core';
import { TransformManifestEntry, TransformResponse } from '../models/transform';
import { EntityType, JsonValue } from '../models/entity';

export interface AppInfo {
  name: string;
  version: string;
  contract_version: number;
}

export interface TransformInput {
  id: string;
  type: EntityType;
  value: string;
  properties: Record<string, JsonValue>;
}

export interface TransformLogEvent {
  job_id: string;
  transform_id: string;
  line: string;
}

/** Error carrying the Rust `AppError.kind` (e.g. `cancelled`, `unavailable`, `timeout`). */
export class BridgeError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

const CASE_FILTER = { name: 'libreOSINT case', extensions: ['case'] };

/**
 * The only place in the UI that talks to `@tauri-apps/api` and Tauri plugins.
 * Outside the Tauri webview (ng serve, unit tests) callers check `isTauri` and use browser fallbacks.
 */
@Injectable({ providedIn: 'root' })
export class TauriBridge {
  readonly isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  /** Browser-preview Ollama requests, cancellable by job id. */
  private readonly browserJobs = new Map<string, AbortController>();

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    if (!this.isTauri) {
      throw new BridgeError('unavailable', `"${command}" needs the desktop app (npm run tauri dev)`);
    }
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      return await invoke<T>(command, args);
    } catch (err) {
      // Rust AppError serializes to { kind, message }.
      const e = err as { kind?: string; message?: string };
      throw new BridgeError(e?.kind ?? 'unknown', e?.message ?? String(err));
    }
  }

  async appInfo(): Promise<AppInfo> {
    if (!this.isTauri) {
      return { name: 'libreOSINT (browser preview)', version: '0.1.0', contract_version: 1 };
    }
    return this.invoke<AppInfo>('app_info');
  }

  // --- files ------------------------------------------------------------------------
  /** Native open dialog for a .case file. Returns null when cancelled. */
  async pickCaseToOpen(): Promise<string | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const res = await open({ multiple: false, directory: false, filters: [CASE_FILTER] });
    return typeof res === 'string' ? res : null;
  }

  /** Native save dialog for a .case file. Returns null when cancelled; always ends in `.case`. */
  async pickCaseToSave(defaultName: string): Promise<string | null> {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const res = await save({ defaultPath: `${defaultName}.case`, filters: [CASE_FILTER] });
    if (!res) return null;
    return /\.case$/i.test(res) ? res : `${res}.case`;
  }

  async confirm(message: string, title = 'libreOSINT'): Promise<boolean> {
    if (!this.isTauri) return window.confirm(message);
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, { title, kind: 'warning' });
  }

  /**
   * Ask before the window closes. `shouldClose` returns false to keep the window open.
   * Desktop: native close request. Browser preview: the standard beforeunload prompt (no custom text possible).
   */
  async guardWindowClose(isDirty: () => boolean, shouldClose: () => Promise<boolean>): Promise<void> {
    if (!this.isTauri) {
      window.addEventListener('beforeunload', (ev) => {
        if (isDirty()) ev.preventDefault();
      });
      return;
    }
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (isDirty() && !(await shouldClose())) event.preventDefault();
    });
  }

  /** Open an http(s) URL in the system browser (the webview must never navigate away). */
  async openExternal(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    if (!this.isTauri) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  }

  // --- transforms -------------------------------------------------------------------
  async transformList(): Promise<TransformManifestEntry[]> {
    if (!this.isTauri) return [];
    return this.invoke<TransformManifestEntry[]>('transform_list');
  }

  transformRun(
    jobId: string,
    transformId: string,
    entity: TransformInput,
    params: Record<string, JsonValue> = {},
    proxy: string | null = null,
  ): Promise<TransformResponse> {
    return this.invoke<TransformResponse>('transform_run', { jobId, transformId, entity, params, proxy });
  }

  /** Public IP that lookups would come from with this proxy. */
  networkCheck(proxy: string | null): Promise<{ ip: string; proxied: boolean }> {
    return this.invoke('network_check', { proxy });
  }

  /** Subscribe to live transform stderr lines. Returns an unsubscribe function. */
  async onTransformLog(handler: (e: TransformLogEvent) => void): Promise<() => void> {
    if (!this.isTauri) return () => undefined;
    const { listen } = await import('@tauri-apps/api/event');
    return listen<TransformLogEvent>('transform://log', (ev) => handler(ev.payload));
  }

  async cancelJob(jobId: string): Promise<void> {
    const browserJob = this.browserJobs.get(jobId);
    if (browserJob) {
      browserJob.abort();
      return;
    }
    if (this.isTauri) await this.invoke<boolean>('job_cancel', { jobId });
  }

  // --- Ollama -----------------------------------------------------------------------
  async ollamaModels(baseUrl: string): Promise<string[]> {
    if (this.isTauri) return this.invoke<string[]>('ollama_models', { baseUrl });
    const res = await this.browserFetch(`${trimUrl(baseUrl)}/api/tags`);
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name).sort();
  }

  async ollamaChat<T>(jobId: string, baseUrl: string, body: Record<string, unknown>): Promise<T> {
    if (this.isTauri) return this.invoke<T>('ollama_chat', { jobId, baseUrl, body });
    const ctrl = new AbortController();
    this.browserJobs.set(jobId, ctrl);
    try {
      const res = await this.browserFetch(`${trimUrl(baseUrl)}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stream: false }),
        signal: ctrl.signal,
      });
      return (await res.json()) as T;
    } finally {
      this.browserJobs.delete(jobId);
    }
  }

  private async browserFetch(url: string, init?: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new BridgeError('cancelled', 'cancelled');
      throw new BridgeError('unavailable', `cannot reach Ollama at ${url} — is it running? (\`ollama serve\`)`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BridgeError('unavailable', `Ollama returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res;
  }
}

function trimUrl(url: string): string {
  return (url.trim() || 'http://localhost:11434').replace(/\/+$/, '');
}
