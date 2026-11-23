import { Injectable, computed, inject, signal } from '@angular/core';
import { CaseSnapshot } from '../models/case';
import { ConsoleLog } from './console-log';
import { GraphStore } from './graph-store';
import { TauriBridge } from './tauri-bridge';
import { ChatService } from './chat';

/**
 * File ▸ New / Open / Save / Save As.
 * Desktop: native dialogs + SQLite `.case` files via Rust.
 * Browser preview: downloads / uploads a JSON snapshot (`*.case.json`) instead.
 */
@Injectable({ providedIn: 'root' })
export class CaseFile {
  private readonly store = inject(GraphStore);
  private readonly bridge = inject(TauriBridge);
  private readonly log = inject(ConsoleLog);
  private readonly chat = inject(ChatService);

  /** Path of the open .case file (desktop only). */
  readonly path = signal<string | null>(null);
  readonly busy = signal(false);
  readonly fileName = computed(() => this.path()?.split(/[\\/]/).pop() ?? null);

  constructor() {
    // Keep the AI conversation and its graph changes on disk when the case already has a file.
    this.chat.onTurnComplete = () => {
      if (this.path() && this.bridge.isTauri) void this.save();
    };
    void this.bridge.guardWindowClose(
      () => this.hasUnsavedWork(),
      () => this.bridge.confirm('This investigation has unsaved changes. Quit without saving?', 'Unsaved changes'),
    );
  }

  async newCase(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.store.reset();
    this.chat.load([]);
    this.path.set(null);
    this.log.log('info', 'case', 'New investigation');
  }

  async open(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    await this.run('open', async () => {
      if (this.bridge.isTauri) {
        const path = await this.bridge.pickCaseToOpen();
        if (!path) return;
        const snap = await this.bridge.invoke<CaseSnapshot>('case_open', { path });
        this.store.load(snap);
        this.chat.load(snap.chat);
        this.path.set(path);
        this.log.log('info', 'case', `Opened ${path} (${snap.entities.length} entities, ${snap.edges.length} links)`);
        if (snap.skipped_entities) {
          this.log.log('warn', 'case', `${snap.skipped_entities} entit${snap.skipped_entities === 1 ? 'y' : 'ies'} of removed types (e.g. ASN, Hash) were left out; saving will drop them from the file`);
        }
      } else {
        const file = await pickBrowserFile();
        if (!file) return;
        const snap = JSON.parse(await file.text()) as CaseSnapshot;
        this.store.load(snap);
        this.chat.load(snap.chat);
        this.path.set(null);
        this.log.log('info', 'case', `Opened ${file.name}`);
      }
    });
  }

  async save(): Promise<void> {
    const path = this.path();
    if (!path) return this.saveAs();
    await this.run('save', () => this.writeTo(path));
  }

  async saveAs(): Promise<void> {
    await this.run('save', async () => {
      if (!this.bridge.isTauri) {
        downloadJson(`${slug(this.store.caseName())}.case.json`, this.snapshot());
        this.store.dirty.set(false);
        this.log.log('info', 'case', 'Browser preview: downloaded the case as JSON (native .case files need the desktop app)');
        return;
      }
      const path = await this.bridge.pickCaseToSave(slug(this.store.caseName()));
      if (!path) return;
      // Name the investigation after the file when it is still untitled.
      if (this.store.caseName().startsWith('Untitled')) {
        this.store.caseName.set(path.split(/[\\/]/).pop()!.replace(/\.case$/i, ''));
      }
      await this.writeTo(path);
      this.path.set(path);
    });
  }

  private async writeTo(path: string): Promise<void> {
    await this.bridge.invoke('case_save', { path, snapshot: this.snapshot() });
    this.store.dirty.set(false);
    this.log.log('info', 'case', `Saved ${path}`);
  }

  private snapshot(): CaseSnapshot {
    return { ...this.store.snapshot(), chat: this.chat.messages() };
  }

  /** Unsaved changes worth asking about: anything in a saved case, or a new one with entities or chat. */
  private hasUnsavedWork(): boolean {
    return this.store.dirty() && (!!this.path() || this.store.counts().entities > 0 || this.chat.messages().length > 0);
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!this.hasUnsavedWork()) return true;
    return this.bridge.confirm('Discard unsaved changes to the current investigation?');
  }

  private async run(action: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await fn();
    } catch (err) {
      this.log.log('error', 'case', `Could not ${action}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.busy.set(false);
    }
  }
}

function slug(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'investigation';
}

function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function pickBrowserFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
