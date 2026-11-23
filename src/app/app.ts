import { ChangeDetectionStrategy, Component, OnInit, effect, inject } from '@angular/core';
import { Palette } from './features/palette/palette';
import { Canvas } from './features/canvas/canvas';
import { Sidebar } from './features/sidebar/sidebar';
import { About } from './features/about/about';
import { Settings } from './features/settings/settings';
import { NetworkSettings } from './core/services/network-settings';
import { UiState } from './core/services/ui-state';
import { Console } from './features/console/console';
import { Menubar } from './features/menubar/menubar';
import { ThemeService } from './core/services/theme';
import { TauriBridge } from './core/services/tauri-bridge';
import { ConsoleLog } from './core/services/console-log';
import { GraphStore } from './core/services/graph-store';
import { CaseFile } from './core/services/case-file';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Menubar, Palette, Canvas, Sidebar, Console, About, Settings],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
  protected readonly theme = inject(ThemeService);
  protected readonly store = inject(GraphStore);
  protected readonly caseFile = inject(CaseFile);
  protected readonly log = inject(ConsoleLog);
  protected readonly ui = inject(UiState);
  protected readonly network = inject(NetworkSettings);
  private readonly bridge = inject(TauriBridge);

  constructor() {
    // Window/tab title: "● name — libreOSINT" while there are unsaved changes.
    effect(() => {
      document.title = `${this.store.dirty() ? '● ' : ''}${this.store.caseName()} — libreOSINT`;
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      const info = await this.bridge.appInfo();
      this.log.log('info', 'app', `${info.name} v${info.version} — transform contract v${info.contract_version}`);
    } catch (err) {
      this.log.log('error', 'app', `Backend unreachable: ${String(err)}`);
    }
  }

  protected rename(input: HTMLInputElement): void {
    const name = input.value.trim();
    if (!name) {
      input.value = this.store.caseName();
    } else if (name !== this.store.caseName()) {
      this.store.caseName.set(name);
      this.store.dirty.set(true);
    }
  }
}
