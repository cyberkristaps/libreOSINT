import { Injectable, effect, signal } from '@angular/core';
import { Subject } from 'rxjs';

export type LayoutName = 'tidy' | 'cola' | 'concentric' | 'dagre' | 'breadthfirst';

export const LAYOUTS: { name: LayoutName; label: string }[] = [
  { name: 'tidy', label: 'Tidy (branches)' },
  { name: 'cola', label: 'Force-directed (Cola)' },
  { name: 'concentric', label: 'Concentric' },
  { name: 'dagre', label: 'Hierarchical' },
  { name: 'breadthfirst', label: 'Breadth-first' },
];

export type CanvasCommand = { kind: 'layout'; name: LayoutName } | { kind: 'fit' } | { kind: 'selectAll' } | { kind: 'toggleLinkMode' };

const AUTO_TIDY_KEY = 'libre-osint.autoTidy';

/** Lets the menu bar drive the Cytoscape canvas without touching Cytoscape directly. */
@Injectable({ providedIn: 'root' })
export class CanvasControl {
  private readonly subject = new Subject<CanvasCommand>();
  readonly commands = this.subject.asObservable();

  /** Re-tidy the graph whenever a lookup adds entities (on unless the user turned it off). */
  readonly autoTidy = signal(localStorage.getItem(AUTO_TIDY_KEY) !== 'off');

  constructor() {
    effect(() => localStorage.setItem(AUTO_TIDY_KEY, this.autoTidy() ? 'on' : 'off'));
  }

  send(cmd: CanvasCommand): void {
    this.subject.next(cmd);
  }

  /** Call after a lookup changed the graph. */
  afterLookup(created: number): void {
    if (created > 0 && this.autoTidy()) this.send({ kind: 'layout', name: 'tidy' });
  }
}
