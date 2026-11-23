import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { UiState } from '../../core/services/ui-state';
import { NetworkMode, NetworkSettings } from '../../core/services/network-settings';
import { BridgeError, TauriBridge } from '../../core/services/tauri-bridge';

interface CheckResult {
  ok: boolean;
  text: string;
}

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-backdrop" (click)="close()"></div>
    <div class="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" (keydown.escape)="close()">
      <h2 id="settings-title">Settings</h2>

      <section>
        <h3>Network for lookups</h3>
        <p class="muted small">
          Lookups contact third-party services and sometimes the target itself. Route them through a proxy so they
          don't come from your own IP address.
        </p>
        <div class="radio-list" role="radiogroup" aria-label="Network for lookups">
          @for (o of options; track o.mode) {
            <label class="radio">
              <input type="radio" name="net-mode" [value]="o.mode" [checked]="network.mode() === o.mode" (change)="setMode(o.mode)" />
              <span>
                <strong>{{ o.label }}</strong>
                <span class="muted small">{{ o.hint }}</span>
              </span>
            </label>
          }
        </div>
        @if (network.mode() === 'custom') {
          <input
            #custom
            class="mono custom-proxy"
            placeholder="socks5h://127.0.0.1:1080  or  http://proxy:8080"
            aria-label="Proxy URL"
            [value]="network.customUrl()"
            (input)="network.customUrl.set(custom.value.trim()); result.set(null)"
          />
        }
        <div class="check-row">
          <button type="button" [disabled]="checking() || !bridge.isTauri || network.missingUrl()" (click)="check()">
            {{ checking() ? 'Checking…' : 'Test connection' }}
          </button>
          @if (!bridge.isTauri) {
            <span class="muted small">Available in the desktop app.</span>
          } @else if (network.missingUrl()) {
            <span class="small bad">Enter a proxy URL. Lookups are blocked until you do.</span>
          } @else if (result(); as r) {
            <span class="small" [class.ok]="r.ok" [class.bad]="!r.ok">{{ r.text }}</span>
          }
        </div>
        <ul class="muted small settings-notes">
          <li>If the proxy is unreachable, lookups fail rather than falling back to a direct connection.</li>
          <li>Hostnames are resolved through the proxy (no DNS leaks); DNS lookups switch to DNS-over-HTTPS.</li>
          <li>The AI chat's connection to your local Ollama is not proxied.</li>
          <li>Credentials in a custom proxy URL are stored in this app's settings on this computer.</li>
        </ul>
      </section>

      <div class="modal-actions">
        <button #closeBtn type="button" class="primary" (click)="close()">Done</button>
      </div>
    </div>
  `,
})
export class Settings {
  protected readonly ui = inject(UiState);
  protected readonly network = inject(NetworkSettings);
  protected readonly bridge = inject(TauriBridge);
  protected readonly checking = signal(false);
  protected readonly result = signal<CheckResult | null>(null);
  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>('closeBtn');

  protected readonly options: { mode: NetworkMode; label: string; hint: string }[] = [
    { mode: 'direct', label: 'Direct', hint: 'Lookups come from your own IP address.' },
    { mode: 'custom', label: 'Proxy', hint: 'SOCKS5 or HTTP(S) proxy URL.' },
  ];

  constructor() {
    afterNextRender(() => this.closeBtn()?.nativeElement.focus());
  }

  protected setMode(mode: NetworkMode): void {
    this.network.mode.set(mode);
    this.result.set(null);
  }

  async check(): Promise<void> {
    if (this.network.missingUrl()) return; // never test (or connect) directly while proxy mode is on
    this.checking.set(true);
    this.result.set(null);
    try {
      const r = await this.bridge.networkCheck(this.network.proxy());
      this.result.set({
        ok: this.network.mode() === 'direct' || r.proxied,
        text: `Lookups exit from ${r.ip}`,
      });
    } catch (err) {
      this.result.set({ ok: false, text: (err as BridgeError).message });
    } finally {
      this.checking.set(false);
    }
  }

  protected close(): void {
    this.ui.settingsOpen.set(false);
  }
}
