import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import cytoscape, { Core } from 'cytoscape';
import cola from 'cytoscape-cola';
import dagre from 'cytoscape-dagre';
import edgehandles from 'cytoscape-edgehandles';
import { suggestEdgeLabels, toEdgeLabel } from '../../core/models/edge-labels';
import { ENTITY_META } from '../../core/models/entity-meta';
import { ENTITY_TYPES, EntityType, isEntityType } from '../../core/models/entity';
import { InvalidValueError } from '../../core/models/normalize';
import { GraphStore } from '../../core/services/graph-store';
import { ConsoleLog } from '../../core/services/console-log';
import { ThemeService } from '../../core/services/theme';
import { CanvasControl, LAYOUTS, LayoutName } from '../../core/services/canvas-control';
import { ENTITY_DRAG_MIME } from '../palette/palette';
import { ContextMenu, MenuEntry } from '../context-menu/context-menu';
import { TransformService } from '../../core/services/transform-service';
import { ChatService } from '../../core/services/chat';
import { UiState } from '../../core/services/ui-state';
import { BridgeError } from '../../core/services/tauri-bridge';

let extensionsRegistered = false;
function registerExtensions(): void {
  if (extensionsRegistered) return;
  cytoscape.use(cola);
  cytoscape.use(dagre);
  cytoscape.use(edgehandles);
  extensionsRegistered = true;
}

/** jsdom (unit tests) has no 2D canvas; Cytoscape then runs headless so graph logic stays testable. */
function canRender(): boolean {
  try {
    return !!document.createElement('canvas').getContext('2d');
  } catch {
    return false;
  }
}

interface PendingDrop {
  type: EntityType;
  /** Model (graph) coordinates for the new node. */
  model: { x: number; y: number };
  /** Screen coordinates (relative to the canvas) for the prompt. */
  screen: { x: number; y: number };
  error: string | null;
}

interface PendingLink {
  sourceId: string;
  targetId: string;
  suggestions: string[];
  screen: { x: number; y: number };
  error: string | null;
}

/** Elements edgehandles adds temporarily while a link is being drawn. */
const EH_TEMP_CLASSES = ['eh-ghost', 'eh-ghost-node', 'eh-ghost-edge', 'eh-preview'];
const isTemp = (el: cytoscape.SingularElementArgument) => EH_TEMP_CLASSES.some((c) => el.hasClass(c));

@Component({
  selector: 'app-canvas',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ContextMenu],
  template: `
    <div class="canvas-toolbar">
      <label>
        Layout
        <select #layoutSelect (change)="runLayout($any(layoutSelect.value))">
          @for (l of layouts; track l.name) {
            <option [value]="l.name">{{ l.label }}</option>
          }
        </select>
      </label>
      <button type="button" title="Run the selected layout again" aria-label="Run the selected layout again" (click)="runLayout($any(layoutSelect.value))">↻</button>
      <button type="button" (click)="fit()">Fit</button>
      <button
        type="button"
        class="link-toggle"
        [class.active]="drawing()"
        [attr.aria-pressed]="linkMode()"
        title="Link mode: drag from one entity to another to connect them. Tip: hold Shift to link without toggling."
        (click)="setLinkMode(!linkMode())"
      >
        ⤳ Link
      </button>
    </div>
    @if (linkSource(); as src) {
      <p class="canvas-hint">Click the entity to link {{ valueOf(src) }} to · Esc to cancel</p>
    } @else if (drawing() && !pendingLink()) {
      <p class="canvas-hint">Drag from one entity onto another to link them{{ linkMode() ? ' · Esc to exit link mode' : '' }}</p>
    }
    @if (menu(); as m) {
      <app-context-menu [items]="m.items" [at]="m.at" (closed)="menu.set(null)" />
    }
    <div
      #host
      class="cy-host"
      [class.drop-target]="dragOver()"
      (dragover)="onDragOver($event)"
      (dragleave)="dragOver.set(false)"
      (drop)="onDrop($event)"
      (contextmenu)="$event.preventDefault()"
    ></div>
    @if (pendingLink(); as l) {
      <form class="value-prompt link-prompt" [style.left.px]="l.screen.x" [style.top.px]="l.screen.y" (submit)="confirmLink($event, labelInput.value)">
        <div class="link-ends">
          <span class="link-end" [style.color]="colorOf(l.sourceId)">{{ valueOf(l.sourceId) }}</span>
          <span class="muted">→</span>
          <span class="link-end" [style.color]="colorOf(l.targetId)">{{ valueOf(l.targetId) }}</span>
          <button type="button" class="link-swap" title="Swap direction" (click)="swapLink()">⇄</button>
        </div>
        <div class="label-chips">
          @for (s of l.suggestions; track s; let first = $first) {
            <button type="button" class="chip" [class.chip-default]="first" (click)="createLink(s)">{{ s }}</button>
          }
        </div>
        <input
          #labelInput
          class="mono"
          placeholder="…or type a relationship"
          (keydown.enter)="confirmLink($event, labelInput.value)"
          (keydown.escape)="pendingLink.set(null)"
        />
        @if (l.error) {
          <span class="value-prompt-error">{{ l.error }}</span>
        }
        <span class="value-prompt-actions">
          <button type="button" (click)="pendingLink.set(null)">Cancel</button>
          <button type="submit" class="primary">Link</button>
        </span>
      </form>
    }
    @if (empty() && !pending()) {
      <p class="canvas-empty">Drag an entity from the palette to start an investigation.</p>
    }
    @if (pending(); as p) {
      <form class="value-prompt" [style.left.px]="p.screen.x" [style.top.px]="p.screen.y" (submit)="confirmDrop($event, valueInput.value)">
        <label class="value-prompt-label" [style.color]="meta[p.type].color">New {{ meta[p.type].label }}</label>
        <input
          #valueInput
          class="mono"
          autofocus
          [placeholder]="meta[p.type].placeholder"
          (keydown.enter)="confirmDrop($event, valueInput.value)"
          (keydown.escape)="pending.set(null)"
        />
        @if (p.error) {
          <span class="value-prompt-error">{{ p.error }}</span>
        }
        <span class="value-prompt-actions">
          <button type="button" (click)="pending.set(null)">Cancel</button>
          <button type="submit" class="primary">Add</button>
        </span>
      </form>
    }
  `,
  host: {
    class: 'canvas-pane',
    '(document:keydown)': 'onKeyDown($event)',
    '(document:keyup)': 'onKeyUp($event)',
    '(window:blur)': 'setShift(false)',
  },
})
export class Canvas implements AfterViewInit, OnDestroy {
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly valueInput = viewChild<ElementRef<HTMLInputElement>>('valueInput');
  private readonly labelInput = viewChild<ElementRef<HTMLInputElement>>('labelInput');
  private readonly store = inject(GraphStore);
  private readonly log = inject(ConsoleLog);
  private readonly theme = inject(ThemeService);
  private readonly control = inject(CanvasControl);
  private readonly destroyRef = inject(DestroyRef);
  private cy?: Core;
  private headless = false;
  private eh?: ReturnType<Core['edgehandles']>;

  protected readonly layouts = LAYOUTS;
  protected readonly meta = ENTITY_META;
  protected readonly empty = signal(true);
  protected readonly dragOver = signal(false);
  protected readonly pending = signal<PendingDrop | null>(null);
  protected readonly pendingLink = signal<PendingLink | null>(null);
  protected readonly menu = signal<{ items: MenuEntry[]; at: { x: number; y: number } } | null>(null);
  /** "Link from here…": the next entity clicked becomes the link target. */
  protected readonly linkSource = signal<string | null>(null);
  private readonly transforms = inject(TransformService);
  private readonly chat = inject(ChatService);
  private readonly ui = inject(UiState);
  /** Sticky link mode (toolbar / Edit menu). */
  readonly linkMode = signal(false);
  /** Holding Shift temporarily enables link drawing. */
  protected readonly shiftHeld = signal(false);
  protected readonly drawing = computed(() => this.linkMode() || this.shiftHeld());

  constructor() {
    // Keep Cytoscape in sync with the store (store is the source of truth).
    effect(() => {
      const entities = this.store.entities();
      const edges = this.store.edges();
      const positions = this.store.positions();
      untracked(() => this.sync(entities, edges, positions));
    });
    effect(() => {
      const selected = this.store.selectedId() ?? this.store.selectedEdgeId();
      untracked(() => {
        if (!this.cy) return;
        const el = selected ? this.cy.getElementById(selected) : null;
        // Already selected in Cytoscape (e.g. part of a multi-selection made there): keep the rest selected.
        if (el?.nonempty() && el.selected()) return;
        el?.select();
        this.cy.$(':selected').filter((x) => x.id() !== selected).unselect();
      });
    });

    effect(() => {
      const dark = this.theme.theme() === 'dark';
      untracked(() => this.applyThemeColors(dark));
    });
    // Focus the value prompt as soon as it renders.
    effect(() => this.valueInput()?.nativeElement.focus());
    effect(() => this.labelInput()?.nativeElement.focus());
  }

  ngAfterViewInit(): void {
    registerExtensions();
    const headless = (this.headless = !canRender());
    this.cy = cytoscape({
      headless,
      container: headless ? undefined : this.host().nativeElement,
      elements: [],
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(value)',
            'font-size': 10,
            'text-valign': 'bottom',
            'text-margin-y': 4,
            color: '#334155',
            width: 28,
            height: 28,
            'background-color': '#64748b',
            'text-max-width': '160px',
            'text-wrap': 'ellipsis',
          },
        },
        ...ENTITY_TYPES.map((t) => ({
          selector: `node[type = "${t}"]`,
          style: { 'background-color': ENTITY_META[t].color },
        })),
        { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#f59e0b' } },
        { selector: ':parent', style: { 'background-opacity': 0.08, 'border-style': 'dashed' } },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': '#94a3b8',
            'target-arrow-color': '#94a3b8',
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            label: 'data(label)',
            'font-size': 9,
            color: '#64748b',
            'text-rotation': 'autorotate',
            'text-background-color': '#ffffff',
            'text-background-opacity': 0.85,
            'text-background-padding': '2px',
          },
        },
        { selector: 'edge:selected', style: { width: 2.5, 'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b' } },
        // edgehandles (link drawing)
        { selector: '.eh-hover, .eh-source, .eh-target', style: { 'border-width': 3, 'border-color': '#2563eb' } },
        {
          selector: '.eh-preview, .eh-ghost-edge',
          style: { 'line-color': '#2563eb', 'target-arrow-color': '#2563eb', 'line-style': 'dashed', label: '' },
        },
        { selector: '.eh-ghost-edge.eh-preview-active', style: { opacity: 0 } },
        { selector: 'node.eh-ghost-node', style: { opacity: 0, width: 1, height: 1, label: '' } },
      ],
    });
    this.cy.on('select', 'node', (e) => {
      this.store.select(e.target.id());
      this.syncSelectedIds();
    });
    this.cy.on('unselect', 'node', () => {
      if (this.cy!.$('node:selected').empty()) this.store.select(null);
      this.syncSelectedIds();
    });
    this.cy.on('cxttap', (e) => this.openMenu(e));
    this.cy.on('tap', (e) => {
      const src = this.linkSource();
      if (!src) return;
      this.linkSource.set(null);
      if (e.target === this.cy) return; // clicked empty canvas: cancel
      const target = e.target as cytoscape.NodeSingular;
      if (target.isNode() && target.id() !== src && !isTemp(target)) {
        this.openLinkPrompt(this.cy!.getElementById(src) as cytoscape.NodeSingular, target);
      }
    });
    this.cy.on('select', 'edge', (e) => {
      if (!isTemp(e.target)) this.store.selectEdge(e.target.id());
    });
    this.cy.on('unselect', 'edge', () => {
      if (this.cy!.$('edge:selected').empty()) this.store.selectEdge(null);
    });
    if (!headless) {
      // Capture phase on our host runs before Cytoscape's own mousedown handling, so a Shift+drag
      // starts a link even if the Shift keydown never reached us (e.g. Shift pressed outside the window).
      const onPointerDown = (ev: MouseEvent) => {
        // Only ever enables; keyup / window blur turn it off again.
        if (ev.shiftKey && !this.shiftHeld()) this.setShift(true);
      };
      this.el.nativeElement.addEventListener('mousedown', onPointerDown, { capture: true });
      this.destroyRef.onDestroy(() => this.el.nativeElement.removeEventListener('mousedown', onPointerDown, { capture: true }));
      this.eh = this.cy.edgehandles({
        canConnect: (source, target) => !source.same(target) && !isTemp(target),
        snap: true,
        snapThreshold: 30,
        hoverDelay: 80,
      });
      this.cy.on('ehcomplete', (_evt, ...args: unknown[]) => {
        const [source, target, added] = args as [cytoscape.NodeSingular, cytoscape.NodeSingular, cytoscape.EdgeSingular];
        added.remove(); // the store owns edges; it is re-added via sync() once a label is chosen
        this.openLinkPrompt(source, target);
      });
    }
    // Dragging several selected nodes fires one dragfree per node: batch them into one undo step.
    const moved = new Map<string, { x: number; y: number }>();
    this.cy.on('dragfree', 'node', (e) => {
      if (isTemp(e.target)) return;
      if (!moved.size) {
        queueMicrotask(() => {
          this.store.group(moved.size > 1 ? `Move ${moved.size} entities` : 'Move', () => moved.forEach((p, id) => this.store.setPosition(id, p)));
          moved.clear();
        });
      }
      const p = e.target.position();
      moved.set(e.target.id(), { x: p.x, y: p.y });
    });
    this.control.commands.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((cmd) => {
      if (cmd.kind === 'layout') this.runLayout(cmd.name);
      else if (cmd.kind === 'fit') this.fit();
      else if (cmd.kind === 'selectAll') this.cy?.nodes().select();
      else if (cmd.kind === 'toggleLinkMode') this.setLinkMode(!this.linkMode());
    });
    this.sync(this.store.entities(), this.store.edges(), this.store.positions());
    this.applyThemeColors(this.theme.theme() === 'dark');
    void this.transforms.ensureLoaded();
  }

  private syncSelectedIds(): void {
    // Deferred: Cytoscape fires one event per element during box selection.
    queueMicrotask(() => {
      if (this.cy) this.store.selectedIds.set(this.cy.$('node:selected').map((n) => n.id()));
    });
  }

  // --- right-click menu -------------------------------------------------------------
  private openMenu(e: cytoscape.EventObject): void {
    const at = { x: e.renderedPosition.x, y: e.renderedPosition.y };
    const target = e.target;
    this.linkSource.set(null);
    if (target === this.cy) {
      this.menu.set({ at, items: this.canvasMenu(e.position) });
    } else if (target.isNode() && !isTemp(target)) {
      if (!target.selected()) {
        this.cy!.$(':selected').unselect();
        target.select();
      }
      this.menu.set({ at, items: this.nodeMenu(target.id()) });
    } else if (target.isEdge() && !isTemp(target)) {
      this.cy!.$(':selected').unselect();
      target.select();
      this.menu.set({ at, items: this.edgeMenu(target.id()) });
    }
  }

  private nodeMenu(id: string): MenuEntry[] {
    const e = this.store.entities().get(id);
    if (!e) return [];
    const selected = this.store.selectedIds().filter((x) => this.store.entities().has(x));
    const many = selected.length > 1 && selected.includes(id);
    const lookups = this.transforms.forType(e.type);
    const run: MenuEntry = this.transforms.available
      ? {
          label: 'Run lookup',
          disabled: !lookups.length,
          hint: lookups.length ? undefined : `No lookups accept ${e.type}`,
          children: lookups.map((t) => ({ label: t.name, hint: t.description, action: () => void this.runLookup(t.id, id) })),
        }
      : { label: 'Run lookup', disabled: true, hint: 'Lookups run in the desktop app (npm run tauri dev)' };
    return [
      run,
      { label: 'Ask AI about this', action: () => this.askAi(id) },
      'separator',
      { label: 'Link from here…', action: () => this.linkSource.set(id) },
      { label: 'Copy value', action: () => void navigator.clipboard?.writeText(e.value) },
      'separator',
      many
        ? { label: `Delete ${selected.length} selected entities`, danger: true, action: () => this.deleteEntities(selected) }
        : { label: 'Delete entity', danger: true, action: () => this.deleteEntities([id]) },
    ];
  }

  private edgeMenu(id: string): MenuEntry[] {
    const edge = this.store.edges().get(id);
    if (!edge) return [];
    return [
      { label: 'Swap direction', action: () => this.store.selectEdge(this.store.reverseEdge(id)?.id ?? null) },
      { label: 'Copy label', action: () => void navigator.clipboard?.writeText(edge.label) },
      'separator',
      {
        label: 'Delete link',
        danger: true,
        action: () => {
          this.store.removeEdge(id);
          this.log.log('info', 'canvas', `Removed link ${this.valueOf(edge.source_id)} —${edge.label}→ ${this.valueOf(edge.target_id)}`);
        },
      },
    ];
  }

  private canvasMenu(model: { x: number; y: number }): MenuEntry[] {
    return [
      {
        label: 'Add entity',
        children: ENTITY_TYPES.map((t) => ({
          label: ENTITY_META[t].label,
          color: ENTITY_META[t].color,
          action: () => this.openValuePrompt(t, model),
        })),
      },
      'separator',
      { label: 'Select all', disabled: this.store.counts().entities === 0, action: () => this.cy?.nodes().select() },
      { label: 'Fit graph', disabled: this.store.counts().entities === 0, action: () => this.fit() },
      { label: 'Layout', children: LAYOUTS.map((l) => ({ label: l.label, action: () => this.runLayout(l.name) })) },
    ];
  }

  private async runLookup(transformId: string, entityId: string): Promise<void> {
    const e = this.store.entities().get(entityId);
    if (!e) return;
    try {
      await this.transforms.runOnEntity(transformId, e);
    } catch (err) {
      if ((err as BridgeError).kind !== 'cancelled') this.log.collapsed.set(false);
    }
  }

  private askAi(id: string): void {
    const e = this.store.entities().get(id);
    if (!e) return;
    this.store.select(id);
    this.ui.rightTab.set('chat');
    this.chat.draft.set(
      `Investigate the ${ENTITY_META[e.type].label} "${e.value}". Look it up, add relevant findings to the graph and note your conclusions.`,
    );
  }

  private deleteEntities(ids: string[]): void {
    const names = ids.map((i) => this.valueOf(i));
    this.store.removeEntities(ids);
    this.log.log('info', 'canvas', ids.length === 1 ? `Deleted ${names[0]}` : `Deleted ${ids.length} entities`);
  }

  // --- drag & drop from the palette -------------------------------------------------
  protected onDragOver(ev: DragEvent): void {
    if (!ev.dataTransfer?.types.includes(ENTITY_DRAG_MIME)) return;
    ev.preventDefault(); // required, otherwise the browser refuses the drop
    ev.dataTransfer.dropEffect = 'copy';
    this.dragOver.set(true);
  }

  protected onDrop(ev: DragEvent): void {
    this.dragOver.set(false);
    const type = ev.dataTransfer?.getData(ENTITY_DRAG_MIME) ?? '';
    if (!isEntityType(type)) return;
    ev.preventDefault();
    const rect = this.host().nativeElement.getBoundingClientRect();
    const screen = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    const pan = this.cy?.pan() ?? { x: 0, y: 0 };
    const zoom = this.cy?.zoom() ?? 1;
    this.openValuePrompt(type, { x: (screen.x - pan.x) / zoom, y: (screen.y - pan.y) / zoom });
  }

  /** Ask for the value of a new entity to be placed at `model` (graph coordinates). */
  private openValuePrompt(type: EntityType, model: { x: number; y: number }): void {
    const rect = this.host().nativeElement.getBoundingClientRect();
    const pan = this.cy?.pan() ?? { x: 0, y: 0 };
    const zoom = this.cy?.zoom() ?? 1;
    const screen = { x: model.x * zoom + pan.x, y: model.y * zoom + pan.y };
    // Keep the prompt (260px wide, centred under the drop point) inside the canvas.
    const promptAt = {
      x: Math.min(Math.max(screen.x, 140), Math.max(140, rect.width - 140)),
      y: Math.min(screen.y, Math.max(0, rect.height - 170)),
    };
    // The prompt may still be open from a previous drop; never carry its text over.
    const input = this.valueInput()?.nativeElement;
    if (input) input.value = '';
    this.pending.set({ type, model, screen: promptAt, error: null });
  }

  protected confirmDrop(ev: Event, value: string): void {
    ev.preventDefault();
    const p = this.pending();
    if (!p) return;
    try {
      const { entity, created } = this.store.upsertEntity({ type: p.type, value }, p.model);
      this.log.log('info', 'canvas', created ? `Added ${entity.type} ${entity.value}` : `${entity.type} ${entity.value} already exists — selected it`);
      this.pending.set(null);
      this.store.select(entity.id);
    } catch (err) {
      const msg = err instanceof InvalidValueError ? err.message : String(err);
      this.pending.set({ ...p, error: msg });
    }
  }

  // --- linking entities -----------------------------------------------------------
  protected onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Shift' && !ev.repeat && !this.pending() && !this.pendingLink()) this.setShift(true);
    if (ev.key === 'Escape' && this.linkSource()) this.linkSource.set(null);
    else if (ev.key === 'Escape' && this.linkMode() && !this.pendingLink()) this.setLinkMode(false);
  }

  protected onKeyUp(ev: KeyboardEvent): void {
    if (ev.key === 'Shift') this.setShift(false);
  }

  setLinkMode(on: boolean): void {
    this.linkMode.set(on);
    this.applyDrawMode();
  }

  protected setShift(on: boolean): void {
    this.shiftHeld.set(on);
    this.applyDrawMode();
  }

  /** Applied synchronously (not via an effect) so a drag that starts right after the toggle already draws a link. */
  private applyDrawMode(): void {
    if (this.drawing()) this.eh?.enableDrawMode();
    else this.eh?.disableDrawMode();
  }

  private openLinkPrompt(source: cytoscape.NodeSingular, target: cytoscape.NodeSingular): void {
    const a = this.store.entities().get(source.id());
    const b = this.store.entities().get(target.id());
    if (!a || !b) return;
    const pa = source.renderedPosition();
    const pb = target.renderedPosition();
    const w = this.cy!.width();
    const h = this.cy!.height();
    this.pendingLink.set({
      sourceId: a.id,
      targetId: b.id,
      suggestions: suggestEdgeLabels(a.type, b.type),
      screen: {
        x: Math.min(Math.max((pa.x + pb.x) / 2, 150), Math.max(150, w - 150)),
        y: Math.min(Math.max((pa.y + pb.y) / 2, 0), Math.max(0, h - 220)),
      },
      error: null,
    });
  }

  protected swapLink(): void {
    const l = this.pendingLink();
    const a = l && this.store.entities().get(l.targetId);
    const b = l && this.store.entities().get(l.sourceId);
    if (!l || !a || !b) return;
    this.pendingLink.set({ ...l, sourceId: a.id, targetId: b.id, suggestions: suggestEdgeLabels(a.type, b.type), error: null });
  }

  protected confirmLink(ev: Event, text: string): void {
    ev.preventDefault();
    const l = this.pendingLink();
    if (!l) return;
    const label = text.trim() ? toEdgeLabel(text) : l.suggestions[0];
    if (!label) {
      this.pendingLink.set({ ...l, error: 'Use letters, digits and underscores, e.g. works_at' });
      return;
    }
    this.createLink(label);
  }

  protected createLink(label: string): void {
    const l = this.pendingLink();
    if (!l) return;
    try {
      const existed = [...this.store.edges().values()].some(
        (e) => e.source_id === l.sourceId && e.target_id === l.targetId && e.label === label,
      );
      const edge = this.store.upsertEdge(l.sourceId, l.targetId, label, 'manual');
      this.log.log(
        'info',
        'canvas',
        `${existed ? 'Link already exists' : 'Linked'}: ${this.valueOf(l.sourceId)} —${label}→ ${this.valueOf(l.targetId)}`,
      );
      this.pendingLink.set(null);
      this.store.selectEdge(edge.id);
    } catch (err) {
      this.pendingLink.set({ ...l, error: err instanceof Error ? err.message : String(err) });
    }
  }

  protected valueOf(id: string): string {
    return this.store.entities().get(id)?.value ?? '?';
  }

  protected colorOf(id: string): string {
    const e = this.store.entities().get(id);
    return e ? ENTITY_META[e.type].color : 'inherit';
  }

  // --- commands ---------------------------------------------------------------------
  runLayout(name: LayoutName): void {
    if (!this.cy || this.cy.nodes().empty()) return;
    const layout = this.cy.layout({ name, animate: true, fit: true, padding: 40 } as cytoscape.LayoutOptions);
    layout.one('layoutstop', () => {
      this.store.group('Layout', () => {
        for (const n of this.cy!.nodes()) if (!isTemp(n)) this.store.setPosition(n.id(), { ...n.position() });
      });
    });
    layout.run();
  }

  fit(): void {
    this.cy?.fit(undefined, 40);
  }

  ngOnDestroy(): void {
    this.eh?.destroy();
    this.cy?.destroy();
  }

  // --- store -> cytoscape -------------------------------------------------------------
  private sync(
    entities: ReadonlyMap<string, { id: string; type: string; value: string }>,
    edges: ReadonlyMap<string, { id: string; source_id: string; target_id: string; label: string }>,
    positions: ReadonlyMap<string, { x: number; y: number }>,
  ): void {
    const cy = this.cy;
    if (!cy) return;
    // Entities created without a position (AI tool calls, lookups) get one here so they never stack on one point.
    const placed = new Map<string, { x: number; y: number }>();
    if (!this.headless) cy.resize(); // the cached container size can be stale (e.g. 0 while the window was opening)
    cy.batch(() => {
      cy.elements().forEach((el) => {
        if (isTemp(el)) return;
        const id = el.id();
        const keep = el.group() === 'nodes' ? entities.has(id) : edges.has(id);
        if (!keep) el.remove();
      });
      for (const e of entities.values()) {
        const node = cy.getElementById(e.id);
        const pos = positions.get(e.id);
        if (node.empty()) {
          const at = pos ?? this.placeNew(e.id, edges, positions, placed);
          if (!pos) placed.set(e.id, at);
          cy.add({ group: 'nodes', data: { id: e.id, type: e.type, value: e.value }, position: { ...at } });
        } else {
          node.data({ type: e.type, value: e.value });
          if (pos && !node.grabbed()) node.position({ ...pos });
        }
      }
      for (const e of edges.values()) {
        if (cy.getElementById(e.id).nonempty()) {
          cy.getElementById(e.id).data('label', e.label);
        } else {
          cy.add({ group: 'edges', data: { id: e.id, source: e.source_id, target: e.target_id, label: e.label } });
        }
      }
    });
    this.empty.set(cy.elements().empty());
    if (placed.size) {
      // Persist the chosen spots (outside the effect's own read) and bring new nodes into view.
      queueMicrotask(() => placed.forEach((p, id) => this.store.entities().has(id) && this.store.setPosition(id, p, { history: false })));
      const ext = cy.extent();
      const offscreen = [...placed.values()].some((p) => p.x < ext.x1 || p.x > ext.x2 || p.y < ext.y1 || p.y > ext.y2);
      if (offscreen && !this.headless) cy.animate({ fit: { eles: cy.nodes(), padding: 50 } }, { duration: 300 });
    }
  }

  /** Next to an already-placed neighbour if there is one, else on a spiral around the visible centre. */
  private placeNew(
    id: string,
    edges: ReadonlyMap<string, { source_id: string; target_id: string }>,
    positions: ReadonlyMap<string, { x: number; y: number }>,
    placed: Map<string, { x: number; y: number }>,
  ): { x: number; y: number } {
    const known = (nid: string) => positions.get(nid) ?? placed.get(nid) ?? (this.cy!.getElementById(nid).nonempty() ? this.cy!.getElementById(nid).position() : undefined);
    let anchor: { x: number; y: number } | undefined;
    let siblings = 0;
    for (const e of edges.values()) {
      const other = e.source_id === id ? e.target_id : e.target_id === id ? e.source_id : null;
      if (!other) continue;
      anchor ??= known(other);
      if (anchor) {
        siblings = this.cy!.getElementById(other).degree(false) + placed.size;
        break;
      }
    }
    const golden = 2.399963; // golden angle: even spread without overlaps
    if (anchor) {
      const r = 140 + Math.floor(siblings / 12) * 70;
      const a = siblings * golden;
      return { x: anchor.x + r * Math.cos(a), y: anchor.y + r * Math.sin(a) };
    }
    const ext = this.cy!.extent();
    const cx = Number.isFinite(ext.x1) && ext.w > 0 ? (ext.x1 + ext.x2) / 2 : 0;
    const cyy = Number.isFinite(ext.y1) && ext.h > 0 ? (ext.y1 + ext.y2) / 2 : 0;
    const i = this.cy!.nodes().length + placed.size;
    const r = i === 0 ? 0 : 90 * Math.sqrt(i);
    return { x: cx + r * Math.cos(i * golden), y: cyy + r * Math.sin(i * golden) };
  }

  private applyThemeColors(dark: boolean): void {
    if (!this.cy || this.headless) return;
    this.cy
      .style()
      .selector('node')
      .style('color', dark ? '#cbd5e1' : '#334155')
      .selector('edge')
      .style('color', dark ? '#94a3b8' : '#64748b')
      .style('text-background-color', dark ? '#0b1120' : '#ffffff')
      .update();
  }
}
