import { Injectable, effect, signal } from '@angular/core';

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'libre-osint.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<Theme>(this.initial());

  constructor() {
    effect(() => {
      const t = this.theme();
      document.documentElement.dataset['theme'] = t;
      localStorage.setItem(STORAGE_KEY, t);
    });
  }

  toggle(): void {
    this.theme.update((t) => (t === 'light' ? 'dark' : 'light'));
  }

  private initial(): Theme {
    // Light-first: only honour an explicit stored choice.
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  }
}
