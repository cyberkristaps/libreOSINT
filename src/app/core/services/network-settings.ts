import { Injectable, computed, effect, signal } from '@angular/core';

export type NetworkMode = 'direct' | 'custom';

const KEY = 'libre-osint.network';

/**
 * How lookups reach the internet (per machine). Passed to every transform as OSINT_PROXY; transforms
 * fail instead of going direct when the proxy is down. The AI's connection to Ollama is not affected.
 */
@Injectable({ providedIn: 'root' })
export class NetworkSettings {
  readonly mode = signal<NetworkMode>('direct');
  readonly customUrl = signal('');

  /** The proxy URL lookups use, or null for a direct connection. */
  readonly proxy = computed<string | null>(() => (this.mode() === 'custom' ? this.customUrl().trim() || null : null));

  /** Proxy mode is on but no URL is set: lookups must not run (never fall back to direct). */
  readonly missingUrl = computed(() => this.mode() === 'custom' && !this.customUrl().trim());

  /** The proxy URL without any `user:pass@`, for display. */
  readonly displayProxy = computed(() => {
    const p = this.proxy();
    return p ? redactCredentials(p) : null;
  });

  /** Short label for the top bar, or null when direct. */
  readonly badge = computed(() => (this.proxy() ? 'proxy' : null));

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { mode?: string; customUrl?: string };
      // Unknown or older modes fall back to direct.
      if (s.mode === 'custom') this.mode.set('custom');
      if (typeof s.customUrl === 'string') this.customUrl.set(s.customUrl);
    } catch {
      /* keep defaults */
    }
    effect(() => localStorage.setItem(KEY, JSON.stringify({ mode: this.mode(), customUrl: this.customUrl() })));
  }
}

/** Drop the userinfo part (`user:pass@`) of a URL. */
export function redactCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, '$1');
}
