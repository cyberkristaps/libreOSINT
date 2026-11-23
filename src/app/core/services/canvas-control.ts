import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export type LayoutName = 'cola' | 'concentric' | 'dagre' | 'breadthfirst';

export const LAYOUTS: { name: LayoutName; label: string }[] = [
  { name: 'cola', label: 'Force-directed (Cola)' },
  { name: 'concentric', label: 'Concentric' },
  { name: 'dagre', label: 'Hierarchical' },
  { name: 'breadthfirst', label: 'Breadth-first' },
];

export type CanvasCommand = { kind: 'layout'; name: LayoutName } | { kind: 'fit' } | { kind: 'selectAll' } | { kind: 'toggleLinkMode' };

/** Lets the menu bar drive the Cytoscape canvas without touching Cytoscape directly. */
@Injectable({ providedIn: 'root' })
export class CanvasControl {
  private readonly subject = new Subject<CanvasCommand>();
  readonly commands = this.subject.asObservable();

  send(cmd: CanvasCommand): void {
    this.subject.next(cmd);
  }
}
