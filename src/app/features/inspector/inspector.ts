import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { renderMarkdown } from '../../core/models/markdown';
import { TauriBridge } from '../../core/services/tauri-bridge';
import { GraphStore } from '../../core/services/graph-store';
import { ENTITY_META } from '../../core/models/entity-meta';
import { Edge, Entity, JsonValue } from '../../core/models/entity';
import { toEdgeLabel } from '../../core/models/edge-labels';

interface LinkRow {
  edge: Edge;
  direction: 'out' | 'in';
  otherId: string;
}

/** How a property value is shown and edited: strings as-is, everything else as JSON. */
export function propertyText(v: JsonValue): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Parse edited text back: valid non-string JSON (numbers, booleans, arrays, objects, null) keeps its type. */
export function parsePropertyText(text: string): JsonValue {
  const t = text.trim();
  if (/^(-?\d|\[|\{|true$|false$|null$)/.test(t)) {
    try {
      return JSON.parse(t) as JsonValue;
    } catch {
      /* not JSON: keep as text */
    }
  }
  return text;
}

@Component({
  selector: 'app-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.selected(); as e) {
      <dl class="kv">
        <dt>Type</dt><dd><span class="type-dot" [style.background]="meta[e.type].color"></span>{{ meta[e.type].label }}</dd>
        <dt>Value</dt><dd class="mono">{{ e.value }}</dd>
        <dt>Created</dt><dd>{{ e.created_at }}</dd>
      </dl>

      <h3>Links ({{ links().length }})</h3>
      @if (links().length) {
        <ul class="link-list">
          @for (l of links(); track l.edge.id) {
            <li>
              <button type="button" class="link-row" (click)="store.selectEdge(l.edge.id)" title="Select this link">
                <span class="muted">{{ l.direction === 'out' ? '→' : '←' }}</span>
                <span class="mono link-label">{{ l.edge.label }}</span>
              </button>
              <button type="button" class="link-row link-other" (click)="store.select(l.otherId)" title="Go to entity">
                <span class="type-dot" [style.background]="colorOf(l.otherId)"></span>{{ valueOf(l.otherId) }}
              </button>
            </li>
          }
        </ul>
      } @else {
        <p class="muted">No links. Drag from this entity to another with <kbd>⤳ Link</kbd> on (or hold Shift).</p>
      }

      <h3>Properties</h3>
      <div class="props">
        @for (p of props(); track p.key) {
          <label class="prop-key mono" [attr.for]="'prop-' + p.key" [title]="p.key">{{ p.key }}</label>
          <input
            #valueInput
            class="prop-value mono"
            [id]="'prop-' + p.key"
            [value]="p.text"
            (change)="setProp(e, p.key, valueInput.value)"
            (keydown.enter)="valueInput.blur()"
            (keydown.escape)="valueInput.value = p.text; valueInput.blur()"
          />
          <button type="button" class="icon-x" [title]="'Remove ' + p.key" (click)="removeProp(e, p.key)">×</button>
        }
      </div>
      <form class="prop-add" (submit)="addProp($event, e, newKey, newValue)">
        <input #newKey class="mono" placeholder="new property" aria-label="New property name" (input)="newKeyText.set(newKey.value)" />
        <input #newValue class="mono" placeholder="value" aria-label="New property value" />
        <button type="submit" [disabled]="!newKeyText().trim()">Add</button>
      </form>

      <h3>Tags</h3>
      <div class="tag-list">
        @for (t of e.tags; track t) {
          <span class="tag">{{ t }}<button type="button" class="tag-x" [title]="'Remove tag ' + t" (click)="removeTag(e, t)">×</button></span>
        }
        <input
          #tagInput
          class="tag-input"
          placeholder="add tag…"
          aria-label="Add tag"
          (keydown.enter)="addTags(e, tagInput); $event.preventDefault()"
          (blur)="addTags(e, tagInput)"
        />
      </div>

      <h3 class="notes-head">
        Notes
        @if (!editingNotes()) {
          <button type="button" class="small-btn" (click)="startNotes(e)">Edit</button>
        }
      </h3>
      @if (editingNotes()) {
        <textarea
          #notesInput
          class="notes-editor mono"
          rows="10"
          [value]="notesDraft()"
          (input)="notesDraft.set(notesInput.value)"
          (keydown)="onNotesKey($event, e)"
          placeholder="Markdown: **bold**, \`code\`, - lists, [links](https://…)"
        ></textarea>
        <div class="notes-actions">
          <span class="muted small">⌘/Ctrl+Enter to save · Esc to cancel</span>
          <button type="button" (click)="editingNotes.set(false)">Cancel</button>
          <button type="button" class="primary" (click)="saveNotes(e)">Save</button>
        </div>
      } @else if (e.notes.trim()) {
        <div class="notes-md" [innerHTML]="md(e.notes)" (click)="onNotesClick($event)" (dblclick)="startNotes(e)"></div>
      } @else {
        <p class="muted">No notes. <button type="button" class="link" (click)="startNotes(e)">Add one</button></p>
      }
    } @else if (store.selectedEdge(); as edge) {
      <dl class="kv">
        <dt>Link</dt>
        <dd>
          <input
            #labelInput
            class="mono prop-value"
            aria-label="Link label"
            [value]="edge.label"
            (change)="relabel(edge, labelInput)"
            (keydown.enter)="labelInput.blur()"
            (keydown.escape)="labelInput.value = edge.label; labelInput.blur()"
          />
          @if (labelError()) {
            <span class="value-prompt-error">{{ labelError() }}</span>
          }
        </dd>
        <dt>From</dt>
        <dd>
          <button type="button" class="link-row" (click)="store.select(edge.source_id)">
            <span class="type-dot" [style.background]="colorOf(edge.source_id)"></span>{{ valueOf(edge.source_id) }}
          </button>
        </dd>
        <dt>To</dt>
        <dd>
          <button type="button" class="link-row" (click)="store.select(edge.target_id)">
            <span class="type-dot" [style.background]="colorOf(edge.target_id)"></span>{{ valueOf(edge.target_id) }}
          </button>
        </dd>
        <dt>Source</dt><dd>{{ edge.transform_source }}</dd>
        <dt>Updated</dt><dd>{{ edge.timestamp }}</dd>
      </dl>
      <span class="link-actions">
        <button type="button" (click)="store.selectEdge(store.reverseEdge(edge.id)?.id ?? null)">⇄ Swap direction</button>
        <button type="button" class="danger" (click)="store.removeEdge(edge.id)">Delete link</button>
      </span>
    } @else {
      <p class="muted">Select an entity or link to inspect it.</p>
    }
  `,
})
export class Inspector {
  protected readonly store = inject(GraphStore);
  protected readonly meta = ENTITY_META;
  private readonly sanitizer = inject(DomSanitizer);
  private readonly bridge = inject(TauriBridge);

  protected readonly editingNotes = signal(false);
  protected readonly notesDraft = signal('');
  protected readonly labelError = signal('');
  /** Mirrors the "new property" input so the Add button updates under OnPush. */
  protected readonly newKeyText = signal('');

  protected readonly props = computed(() => {
    const e = this.store.selected();
    return e ? Object.entries(e.properties).map(([key, v]) => ({ key, text: propertyText(v) })) : [];
  });

  protected readonly links = computed<LinkRow[]>(() => {
    const e = this.store.selected();
    if (!e) return [];
    this.store.edges(); // re-run when edges change
    const { outgoing, incoming } = this.store.linksOf(e.id);
    return [
      ...outgoing.map((edge) => ({ edge, direction: 'out' as const, otherId: edge.target_id })),
      ...incoming.map((edge) => ({ edge, direction: 'in' as const, otherId: edge.source_id })),
    ];
  });

  constructor() {
    // Switching selection abandons an unsaved notes edit and stale errors.
    effect(() => {
      this.store.selectedId();
      this.store.selectedEdgeId();
      this.editingNotes.set(false);
      this.labelError.set('');
      this.newKeyText.set('');
    });
  }

  /** The template's entity can be one render behind; always edit the store's current copy. */
  private cur(e: Entity): Entity {
    return this.store.entities().get(e.id) ?? e;
  }

  // --- properties -------------------------------------------------------------------
  protected setProp(stale: Entity, key: string, text: string): void {
    const e = this.cur(stale);
    const value = parsePropertyText(text);
    if (JSON.stringify(value) === JSON.stringify(e.properties[key])) return;
    this.store.updateEntity(e.id, { properties: { ...e.properties, [key]: value } }, `Edit ${key} on ${e.value}`);
  }

  protected removeProp(stale: Entity, key: string): void {
    const e = this.cur(stale);
    const { [key]: _removed, ...rest } = e.properties;
    this.store.updateEntity(e.id, { properties: rest }, `Remove ${key} from ${e.value}`);
  }

  protected addProp(ev: Event, stale: Entity, keyInput: HTMLInputElement, valueInput: HTMLInputElement): void {
    ev.preventDefault();
    const e = this.cur(stale);
    const key = keyInput.value.trim();
    if (!key) return;
    this.store.updateEntity(e.id, { properties: { ...e.properties, [key]: parsePropertyText(valueInput.value) } }, `Add ${key} to ${e.value}`);
    keyInput.value = '';
    valueInput.value = '';
    this.newKeyText.set('');
    keyInput.focus();
  }

  // --- tags -------------------------------------------------------------------------
  protected addTags(stale: Entity, input: HTMLInputElement): void {
    const e = this.cur(stale);
    const fresh = input.value
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t && !e.tags.includes(t));
    input.value = '';
    if (fresh.length) this.store.updateEntity(e.id, { tags: [...e.tags, ...fresh] }, `Tag ${e.value}`);
  }

  protected removeTag(stale: Entity, tag: string): void {
    const e = this.cur(stale);
    this.store.updateEntity(e.id, { tags: e.tags.filter((t) => t !== tag) }, `Untag ${e.value}`);
  }

  // --- notes ------------------------------------------------------------------------
  protected startNotes(e: Entity): void {
    this.notesDraft.set(e.notes);
    this.editingNotes.set(true);
    queueMicrotask(() => document.querySelector<HTMLTextAreaElement>('.notes-editor')?.focus());
  }

  protected saveNotes(e: Entity): void {
    const current = this.store.entities().get(e.id);
    if (current && current.notes !== this.notesDraft()) {
      this.store.updateEntity(e.id, { notes: this.notesDraft() }, `Edit notes on ${e.value}`);
    }
    this.editingNotes.set(false);
  }

  protected onNotesKey(ev: KeyboardEvent, e: Entity): void {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      this.saveNotes(e);
    } else if (ev.key === 'Escape') {
      this.editingNotes.set(false);
    }
  }

  // --- links ------------------------------------------------------------------------
  protected relabel(edge: Edge, input: HTMLInputElement): void {
    const label = toEdgeLabel(input.value);
    if (!label) {
      this.labelError.set('Use letters, digits and underscores, e.g. works_at');
      input.value = edge.label;
      return;
    }
    this.labelError.set('');
    input.value = label;
    const next = this.store.relabelEdge(edge.id, label);
    if (next) this.store.selectEdge(next.id);
  }

  // --- helpers ----------------------------------------------------------------------
  /** Notes are Markdown (AI findings append timestamped blocks). renderMarkdown escapes all input. */
  protected md(text: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(renderMarkdown(text));
  }

  protected onNotesClick(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a) return;
    ev.preventDefault();
    void this.bridge.openExternal(a.getAttribute('href') ?? '');
  }

  protected valueOf(id: string): string {
    return this.store.entities().get(id)?.value ?? '?';
  }

  protected colorOf(id: string): string {
    const e = this.store.entities().get(id);
    return e ? ENTITY_META[e.type].color : 'transparent';
  }
}
