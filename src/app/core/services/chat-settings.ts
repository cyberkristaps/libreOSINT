import { Injectable, effect, signal } from '@angular/core';

const KEY = 'libre-osint.ai-settings';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

interface Stored {
  url: string;
  model: string;
  autoApply: boolean;
}

/** AI investigator preferences (per machine, not per case). */
@Injectable({ providedIn: 'root' })
export class ChatSettings {
  readonly url = signal(DEFAULT_OLLAMA_URL);
  readonly model = signal('');
  /** When off, graph changes proposed by the AI are shown as cards for review instead of applied. */
  readonly autoApply = signal(true);

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Stored>;
      if (typeof s.url === 'string' && s.url) this.url.set(s.url);
      if (typeof s.model === 'string') this.model.set(s.model);
      if (typeof s.autoApply === 'boolean') this.autoApply.set(s.autoApply);
    } catch {
      /* corrupt settings: keep defaults */
    }
    effect(() => {
      const s: Stored = { url: this.url(), model: this.model(), autoApply: this.autoApply() };
      localStorage.setItem(KEY, JSON.stringify(s));
    });
  }
}
