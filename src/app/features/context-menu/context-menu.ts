import { ChangeDetectionStrategy, Component, ElementRef, afterRenderEffect, input, output, signal, viewChild } from '@angular/core';

export interface MenuAction {
  label: string;
  action?: () => void;
  children?: MenuEntry[];
  disabled?: boolean;
  danger?: boolean;
  hint?: string;
  /** Small coloured dot (entity type colour). */
  color?: string;
}
export type MenuEntry = MenuAction | 'separator';

/** Right-click menu with one level of submenus. Positioned in its parent's coordinate space. */
@Component({
  selector: 'app-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ctx-backdrop" (click)="closed.emit()" (contextmenu)="$event.preventDefault(); closed.emit()"></div>
    <ul #menu class="ctx-menu" role="menu" [style.left.px]="pos().x" [style.top.px]="pos().y" (keydown.escape)="closed.emit()">
      @for (item of items(); track $index) {
        @if (item === 'separator') {
          <li class="menu-separator" role="separator"></li>
        } @else {
          <li
            role="none"
            class="ctx-item-wrap"
            (mouseenter)="openSub.set(item.children ? $index : null)"
          >
            <button
              type="button"
              role="menuitem"
              class="ctx-item"
              [class.danger]="item.danger"
              [disabled]="item.disabled"
              [attr.title]="item.hint ?? null"
              (click)="run(item, $index)"
            >
              @if (item.color) {
                <span class="type-dot" [style.background]="item.color"></span>
              }
              <span class="ctx-label">{{ item.label }}</span>
              @if (item.children) {
                <span class="ctx-arrow">▸</span>
              }
            </button>
            @if (item.children && openSub() === $index) {
              <ul class="ctx-menu ctx-sub" role="menu" [class.flip]="flipSub()" [class.up]="subUp()">
                @for (child of item.children; track $index) {
                  @if (child === 'separator') {
                    <li class="menu-separator" role="separator"></li>
                  } @else {
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        class="ctx-item"
                        [class.danger]="child.danger"
                        [disabled]="child.disabled"
                        [attr.title]="child.hint ?? null"
                        (click)="run(child, null)"
                      >
                        @if (child.color) {
                          <span class="type-dot" [style.background]="child.color"></span>
                        }
                        <span class="ctx-label">{{ child.label }}</span>
                      </button>
                    </li>
                  }
                }
              </ul>
            }
          </li>
        }
      }
    </ul>
  `,
})
export class ContextMenu {
  readonly items = input.required<MenuEntry[]>();
  /** Requested position (relative to the positioned parent); clamped so the menu stays visible. */
  readonly at = input.required<{ x: number; y: number }>();
  readonly closed = output<void>();

  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');
  protected readonly openSub = signal<number | null>(null);
  protected readonly pos = signal({ x: 0, y: 0 });
  protected readonly flipSub = signal(false);
  /** Open submenus upwards when the menu sits in the lower half of the canvas. */
  protected readonly subUp = signal(false);

  constructor() {
    afterRenderEffect(() => {
      const at = this.at();
      const el = this.menu()?.nativeElement;
      const parent = el?.offsetParent as HTMLElement | null;
      if (!el || !parent) {
        this.pos.set(at);
        return;
      }
      const x = Math.max(4, Math.min(at.x, parent.clientWidth - el.offsetWidth - 4));
      const y = Math.max(4, Math.min(at.y, parent.clientHeight - el.offsetHeight - 4));
      if (x !== this.pos().x || y !== this.pos().y) this.pos.set({ x, y });
      // Open submenus to the left when there is no room on the right.
      this.flipSub.set(x + el.offsetWidth + 220 > parent.clientWidth);
      this.subUp.set(y > parent.clientHeight / 2);
      el.querySelector<HTMLButtonElement>('.ctx-item:not(:disabled)')?.focus({ preventScroll: true });
    });
  }

  protected run(item: MenuAction, index: number | null): void {
    if (item.disabled) return;
    if (item.children) {
      // Hover usually opened it already; a click must never close it again.
      this.openSub.set(index);
      return;
    }
    this.closed.emit();
    item.action?.();
  }
}
