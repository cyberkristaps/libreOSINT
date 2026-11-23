import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ENTITY_TYPES, EntityType } from '../../core/models/entity';
import { ENTITY_META } from '../../core/models/entity-meta';

export const ENTITY_DRAG_MIME = 'application/x-libre-osint-entity-type';

@Component({
  selector: 'app-palette',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="pane-title">Entities</h2>
    <ul class="palette-list">
      @for (t of types; track t) {
        <li
          class="palette-item"
          draggable="true"
          [attr.title]="'Drag onto the canvas to add a ' + meta[t].label"
          (dragstart)="onDragStart($event, t)"
        >
          <span class="glyph" [style.background]="meta[t].color">{{ meta[t].glyph }}</span>
          <span>{{ meta[t].label }}</span>
        </li>
      }
    </ul>
  `,
})
export class Palette {
  protected readonly types = ENTITY_TYPES;
  protected readonly meta = ENTITY_META;

  protected onDragStart(ev: DragEvent, type: EntityType): void {
    ev.dataTransfer?.setData(ENTITY_DRAG_MIME, type);
    ev.dataTransfer?.setData('text/plain', type);
    if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy';
  }
}
