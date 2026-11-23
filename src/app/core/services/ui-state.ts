import { Injectable, signal } from '@angular/core';

export type RightTab = 'inspector' | 'chat';

/** Cross-component UI state (which sidebar tab is open, dialogs). */
@Injectable({ providedIn: 'root' })
export class UiState {
  readonly rightTab = signal<RightTab>('inspector');
  readonly aboutOpen = signal(false);
  readonly settingsOpen = signal(false);
}
