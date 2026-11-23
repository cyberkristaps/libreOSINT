import { ChangeDetectionStrategy, Component, ElementRef, OnInit, afterNextRender, inject, signal, viewChild } from '@angular/core';
import { UiState } from '../../core/services/ui-state';
import { TauriBridge } from '../../core/services/tauri-bridge';

/** Placeholder until the public repository exists. */
export const GITHUB_URL = 'https://github.com/cyberkristaps/libreOSINT';

@Component({
  selector: 'app-about',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-backdrop" (click)="ui.aboutOpen.set(false)"></div>
    <div class="modal about" role="dialog" aria-modal="true" aria-labelledby="about-title" (keydown.escape)="ui.aboutOpen.set(false)">
      <img class="about-logo" src="logo.png" alt="" width="64" height="64" />
      <h2 id="about-title">libreOSINT</h2>
      <p class="muted">Version {{ version() }}</p>
      <p>Local-first OSINT and link-analysis workbench.</p>
      <p>
        <a [href]="github" (click)="openGithub($event)">{{ github }}</a>
      </p>
      <button #close type="button" class="primary" (click)="ui.aboutOpen.set(false)">Close</button>
    </div>
  `,
})
export class About implements OnInit {
  protected readonly ui = inject(UiState);
  private readonly bridge = inject(TauriBridge);
  protected readonly version = signal('…');
  protected readonly github = GITHUB_URL;
  private readonly closeBtn = viewChild<ElementRef<HTMLButtonElement>>('close');

  constructor() {
    // Focus inside the dialog so Esc / Enter close it.
    afterNextRender(() => this.closeBtn()?.nativeElement.focus());
  }

  async ngOnInit(): Promise<void> {
    this.version.set((await this.bridge.appInfo()).version);
  }

  protected openGithub(ev: Event): void {
    ev.preventDefault();
    void this.bridge.openExternal(this.github);
  }
}
