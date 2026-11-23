import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CaseFile } from '../../core/services/case-file';
import { CanvasControl, LAYOUTS } from '../../core/services/canvas-control';
import { ConsoleLog } from '../../core/services/console-log';
import { GraphStore } from '../../core/services/graph-store';
import { ThemeService } from '../../core/services/theme';
import { UiState } from '../../core/services/ui-state';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

interface MenuItem {
  label: string | (() => string);
  /** Shortcut as `mod+shift+key` (mod = ⌘ on macOS, Ctrl elsewhere). */
  shortcut?: string;
  action: () => void;
  disabled?: () => boolean;
}
type MenuEntry = MenuItem | 'separator';
interface Menu {
  label: string;
  items: MenuEntry[];
}

function formatShortcut(s: string): string {
  const parts = s.split('+');
  const key = parts.pop()!;
  const keyLabel = key === 'delete' ? (IS_MAC ? '⌫' : 'Del') : key.toUpperCase();
  if (IS_MAC) {
    return parts.map((p) => ({ mod: '⌘', shift: '⇧', alt: '⌥' })[p] ?? p).join('') + keyLabel;
  }
  return [...parts.map((p) => ({ mod: 'Ctrl', shift: 'Shift', alt: 'Alt' })[p] ?? p), keyLabel].join('+');
}

@Component({
  selector: 'app-menubar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="menubar" role="menubar" (keydown.escape)="open.set(null)">
      @for (m of menus; track m.label; let i = $index) {
        <div class="menu">
          <button
            type="button"
            class="menu-trigger"
            role="menuitem"
            aria-haspopup="true"
            [attr.aria-expanded]="open() === i"
            [class.active]="open() === i"
            (click)="open.set(open() === i ? null : i)"
            (mouseenter)="open() !== null && open.set(i)"
          >
            {{ m.label }}
          </button>
          @if (open() === i) {
            <ul class="menu-dropdown" role="menu">
              @for (item of m.items; track $index) {
                @if (item === 'separator') {
                  <li class="menu-separator" role="separator"></li>
                } @else {
                  <li role="none">
                    <button type="button" role="menuitem" [disabled]="item.disabled?.()" (click)="activate(item)">
                      <span class="menu-label">{{ labelOf(item) }}</span>
                      @if (item.shortcut) {
                        <kbd>{{ fmt(item.shortcut) }}</kbd>
                      }
                    </button>
                  </li>
                }
              }
            </ul>
          }
        </div>
      }
    </nav>
    @if (open() !== null) {
      <div class="menu-backdrop" (click)="open.set(null)" (contextmenu)="open.set(null)"></div>
    }
  `,
  host: { '(document:keydown)': 'onKey($event)' },
})
export class Menubar {
  private readonly caseFile = inject(CaseFile);
  private readonly store = inject(GraphStore);
  private readonly canvas = inject(CanvasControl);
  private readonly theme = inject(ThemeService);
  private readonly log = inject(ConsoleLog);
  private readonly ui = inject(UiState);

  protected readonly open = signal<number | null>(null);
  private readonly hasSelection = computed(() => this.store.selectedId() !== null || this.store.selectedEdgeId() !== null);

  protected readonly menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New investigation', shortcut: 'mod+n', action: () => this.caseFile.newCase() },
        { label: 'Open…', shortcut: 'mod+o', action: () => this.caseFile.open() },
        'separator',
        { label: 'Save', shortcut: 'mod+s', action: () => this.caseFile.save() },
        { label: 'Save As…', shortcut: 'mod+shift+s', action: () => this.caseFile.saveAs() },
        'separator',
        { label: 'Settings…', shortcut: 'mod+,', action: () => this.ui.settingsOpen.set(true) },
      ],
    },
    {
      label: 'Edit',
      items: [
        {
          label: () => (this.store.undoLabel() ? `Undo ${this.store.undoLabel()}` : 'Undo'),
          shortcut: 'mod+z',
          action: () => this.store.undo(),
          disabled: () => !this.store.undoLabel(),
        },
        {
          label: () => (this.store.redoLabel() ? `Redo ${this.store.redoLabel()}` : 'Redo'),
          shortcut: 'mod+shift+z',
          action: () => this.store.redo(),
          disabled: () => !this.store.redoLabel(),
        },
        'separator',
        {
          label: 'Delete selected',
          shortcut: 'delete',
          action: () => this.deleteSelected(),
          disabled: () => !this.hasSelection(),
        },
        'separator',
        { label: 'Link mode (drag between entities)', shortcut: 'mod+l', action: () => this.canvas.send({ kind: 'toggleLinkMode' }) },
      ],
    },
    {
      label: 'View',
      items: [
        ...LAYOUTS.map((l) => ({ label: `Layout: ${l.label}`, action: () => this.canvas.send({ kind: 'layout', name: l.name }) })),
        'separator',
        { label: 'Fit graph to window', shortcut: 'mod+0', action: () => this.canvas.send({ kind: 'fit' }) },
        { label: 'Toggle console', shortcut: 'mod+j', action: () => this.log.collapsed.update((c) => !c) },
        { label: 'Toggle dark mode', action: () => this.theme.toggle() },
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'About libreOSINT', action: () => this.ui.aboutOpen.set(true) }],
    },
  ];

  protected fmt = formatShortcut;

  protected labelOf(item: MenuItem): string {
    return typeof item.label === 'function' ? item.label() : item.label;
  }

  protected activate(item: MenuItem): void {
    this.open.set(null);
    if (!item.disabled?.()) item.action();
  }

  protected onKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const mod = IS_MAC ? ev.metaKey : ev.ctrlKey;
    let combo: string;
    if (!mod && (ev.key === 'Delete' || ev.key === 'Backspace')) {
      if (typing) return;
      combo = 'delete';
    } else if (mod) {
      combo = ['mod', ev.shiftKey ? 'shift' : '', ev.altKey ? 'alt' : '', ev.key.toLowerCase()].filter(Boolean).join('+');
      if (combo === 'mod+y') combo = 'mod+shift+z'; // Windows-style redo
      // Inside a text field, undo/redo belong to the field.
      if (typing && (combo === 'mod+z' || combo === 'mod+shift+z')) return;
    } else {
      return;
    }
    for (const m of this.menus) {
      for (const item of m.items) {
        if (item !== 'separator' && item.shortcut === combo) {
          ev.preventDefault();
          this.activate(item);
          return;
        }
      }
    }
  }

  private deleteSelected(): void {
    const edge = this.store.selectedEdge();
    if (edge) {
      const name = (id: string) => this.store.entities().get(id)?.value ?? '?';
      this.store.removeEdge(edge.id);
      this.log.log('info', 'canvas', `Removed link ${name(edge.source_id)} —${edge.label}→ ${name(edge.target_id)}`);
      return;
    }
    const entities = this.store.entities();
    const primary = this.store.selectedId();
    const ids = [...new Set([...this.store.selectedIds(), ...(primary ? [primary] : [])])].filter((id) => entities.has(id));
    if (!ids.length) return;
    if (ids.length > 1) {
      this.store.removeEntities(ids);
      this.log.log('info', 'canvas', `Deleted ${ids.length} entities`);
      return;
    }
    const e = entities.get(ids[0])!;
    const links = this.store.linksOf(e.id);
    this.store.removeEntities([e.id]);
    const n = links.incoming.length + links.outgoing.length;
    this.log.log('info', 'canvas', `Deleted ${e.type} ${e.value}${n ? ` and ${n} link${n === 1 ? '' : 's'}` : ''}`);
  }

}
