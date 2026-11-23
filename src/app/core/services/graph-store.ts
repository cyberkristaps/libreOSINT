import { Injectable, computed, signal } from '@angular/core';
import { Edge, Entity, EntityType, JsonValue } from '../models/entity';
import { CASE_FORMAT, CASE_FORMAT_VERSION, CaseSnapshot, LEGACY_CASE_FORMATS, Position } from '../models/case';
import { entityKey, locationInfo, normalizeValue, socialAccountInfo } from '../models/normalize';

export interface EntityInput {
  type: EntityType;
  value: string;
  properties?: Record<string, JsonValue>;
  tags?: string[];
  notes?: string;
}

export interface UpsertResult {
  entity: Entity;
  /** false when the input merged into an existing entity (dedup). */
  created: boolean;
}

const DEFAULT_CASE_NAME = 'Untitled investigation';
const MAX_HISTORY = 200;

interface HistoryState {
  entities: ReadonlyMap<string, Entity>;
  edges: ReadonlyMap<string, Edge>;
  positions: ReadonlyMap<string, Position>;
  /** What the step did, e.g. "Add Domain example.com" (shown as "Undo Add Domain example.com"). */
  label: string;
}

/** Types whose canonical form is also the clearest label, so it is stored instead of the first-seen spelling. */
const STORE_CANONICAL: ReadonlySet<EntityType> = new Set(['Phone_Number']);

/** Properties we can infer from the value alone (given properties always win). */
function derivedProperties(type: EntityType, value: string): Record<string, JsonValue> {
  const info = type === 'Social_Account' ? socialAccountInfo(value) : type === 'Location' ? locationInfo(value) : null;
  return info ? { ...info } : {};
}

/**
 * UI-side graph state and the dedup rules from CLAUDE.md:
 * entities are unique on (type, normalized value); edges on (source, target, label).
 * Rust enforces the same rules when a case is saved.
 */
@Injectable({ providedIn: 'root' })
export class GraphStore {
  readonly entities = signal<ReadonlyMap<string, Entity>>(new Map());
  readonly edges = signal<ReadonlyMap<string, Edge>>(new Map());
  readonly positions = signal<ReadonlyMap<string, Position>>(new Map());
  /** Selected entity (node). Mutually exclusive with `selectedEdgeId`. */
  readonly selectedId = signal<string | null>(null);
  readonly selectedEdgeId = signal<string | null>(null);
  /** All selected entity ids on the canvas (multi-select); `selectedId` is the primary one. */
  readonly selectedIds = signal<readonly string[]>([]);
  readonly caseName = signal(DEFAULT_CASE_NAME);
  /** True when there are changes not yet written to the current .case file. */
  readonly dirty = signal(false);
  /** Label of the step Undo / Redo would revert, or null when there is none. */
  readonly undoLabel = signal<string | null>(null);
  readonly redoLabel = signal<string | null>(null);

  private past: HistoryState[] = [];
  private future: HistoryState[] = [];
  private groupDepth = 0;
  private groupLabel = '';
  private groupRecorded = false;

  readonly selected = computed(() => {
    const id = this.selectedId();
    return id ? (this.entities().get(id) ?? null) : null;
  });

  readonly selectedEdge = computed(() => {
    const id = this.selectedEdgeId();
    return id ? (this.edges().get(id) ?? null) : null;
  });

  readonly counts = computed(() => ({ entities: this.entities().size, edges: this.edges().size }));

  private readonly byKey = computed(() => {
    const m = new Map<string, string>();
    for (const e of this.entities().values()) m.set(entityKey(e.type, e.value), e.id);
    return m;
  });

  /** Add an entity or merge into the existing one with the same identity key. Throws InvalidValueError. */
  upsertEntity(input: EntityInput, position?: Position): UpsertResult {
    const key = entityKey(input.type, input.value);
    const existingId = this.byKey().get(key);
    return this.group(`${existingId ? 'Update' : 'Add'} ${input.type} ${input.value.trim()}`, () => this.upsertEntityInner(input, existingId, position));
  }

  private upsertEntityInner(input: EntityInput, existingId: string | undefined, position?: Position): UpsertResult {
    this.record('');
    if (existingId) {
      const prev = this.entities().get(existingId)!;
      const merged: Entity = {
        ...prev,
        properties: { ...prev.properties, ...(input.properties ?? {}) },
        tags: [...new Set([...prev.tags, ...(input.tags ?? [])])],
      };
      this.setEntity(merged);
      return { entity: merged, created: false };
    }
    const entity: Entity = {
      id: crypto.randomUUID(),
      type: input.type,
      value: STORE_CANONICAL.has(input.type) ? normalizeValue(input.type, input.value) : input.value.trim(),
      properties: { ...derivedProperties(input.type, input.value), ...(input.properties ?? {}) },
      notes: input.notes ?? '',
      tags: [...new Set(input.tags ?? [])],
      created_at: new Date().toISOString(),
    };
    this.setEntity(entity);
    if (position) this.setPosition(entity.id, position, { history: false });
    return { entity, created: true };
  }

  /** Add an edge, or refresh timestamp/transform_source of the existing (source, target, label) edge. */
  upsertEdge(sourceId: string, targetId: string, label: string, transformSource = 'manual'): Edge {
    const ents = this.entities();
    if (!ents.has(sourceId) || !ents.has(targetId)) throw new Error('Edge endpoints must exist');
    if (sourceId === targetId) throw new Error('An entity cannot link to itself');
    const existing = [...this.edges().values()].find(
      (e) => e.source_id === sourceId && e.target_id === targetId && e.label === label,
    );
    this.record(`Link ${ents.get(sourceId)!.value} —${label}→ ${ents.get(targetId)!.value}`);
    const edge: Edge = {
      id: existing?.id ?? crypto.randomUUID(),
      source_id: sourceId,
      target_id: targetId,
      label,
      transform_source: transformSource,
      timestamp: new Date().toISOString(),
    };
    this.edges.update((m) => new Map(m).set(edge.id, edge));
    this.dirty.set(true);
    return edge;
  }

  updateEntity(id: string, patch: Partial<Pick<Entity, 'properties' | 'notes' | 'tags'>>, label?: string): void {
    const prev = this.entities().get(id);
    if (!prev) return;
    this.record(label ?? `Edit ${prev.value}`);
    this.setEntity({ ...prev, ...patch });
  }

  /** Change a link's label; merges into an existing identical link if there is one. */
  relabelEdge(id: string, label: string): Edge | null {
    const e = this.edges().get(id);
    if (!e || e.label === label) return e ?? null;
    return this.group(`Relabel link to ${label}`, () => {
      this.removeEdge(id);
      return this.upsertEdge(e.source_id, e.target_id, label, e.transform_source);
    });
  }

  /** Remove entities and every edge touching them. */
  removeEntities(ids: Iterable<string>): void {
    const drop = new Set(ids);
    if (drop.size === 0) return;
    const one = drop.size === 1 ? this.entities().get([...drop][0]) : undefined;
    this.record(one ? `Delete ${one.value}` : `Delete ${drop.size} entities`);
    this.entities.update((m) => new Map([...m].filter(([id]) => !drop.has(id))));
    this.positions.update((m) => new Map([...m].filter(([id]) => !drop.has(id))));
    this.edges.update(
      (m) => new Map([...m].filter(([, e]) => !drop.has(e.source_id) && !drop.has(e.target_id))),
    );
    if (drop.has(this.selectedId() ?? '')) this.selectedId.set(null);
    this.selectedIds.update((ids) => ids.filter((id) => !drop.has(id)));
    if (!this.edges().has(this.selectedEdgeId() ?? '')) this.selectedEdgeId.set(null);
    this.dirty.set(true);
  }

  removeEdge(id: string): void {
    if (!this.edges().has(id)) return;
    this.record('Delete link');
    this.edges.update((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
    if (this.selectedEdgeId() === id) this.selectedEdgeId.set(null);
    this.dirty.set(true);
  }

  /** Replace an edge with the same edge pointing the other way. Returns the new edge. */
  reverseEdge(id: string): Edge | null {
    const e = this.edges().get(id);
    if (!e) return null;
    return this.group('Swap link direction', () => {
      this.removeEdge(id);
      return this.upsertEdge(e.target_id, e.source_id, e.label, e.transform_source);
    });
  }

  /** Edges touching an entity, split by direction. */
  linksOf(id: string): { outgoing: Edge[]; incoming: Edge[] } {
    const outgoing: Edge[] = [];
    const incoming: Edge[] = [];
    for (const e of this.edges().values()) {
      if (e.source_id === id) outgoing.push(e);
      if (e.target_id === id) incoming.push(e);
    }
    return { outgoing, incoming };
  }

  /** `history: false` for automatic placement, which should not become its own undo step. */
  setPosition(id: string, pos: Position, opts: { history?: boolean } = {}): void {
    const prev = this.positions().get(id);
    if (prev && prev.x === pos.x && prev.y === pos.y) return;
    if (opts.history !== false) this.record('Move');
    this.positions.update((m) => new Map(m).set(id, { x: pos.x, y: pos.y }));
    this.dirty.set(true);
  }

  select(id: string | null): void {
    this.selectedId.set(id);
    if (id) this.selectedEdgeId.set(null);
  }

  selectEdge(id: string | null): void {
    this.selectedEdgeId.set(id);
    if (id) this.selectedId.set(null);
  }

  // --- undo / redo ------------------------------------------------------------------

  /** Run `fn` as one undo step (nested groups join the outer one). A group with no changes adds no step. */
  group<T>(label: string, fn: () => T): T {
    this.beginGroup(label);
    try {
      return fn();
    } finally {
      this.endGroup();
    }
  }

  /** Async-friendly grouping (e.g. a whole AI turn). Always pair with endGroup(). */
  beginGroup(label: string): void {
    if (this.groupDepth++ === 0) {
      this.groupLabel = label;
      this.groupRecorded = false;
    }
  }

  endGroup(): void {
    this.groupDepth = Math.max(0, this.groupDepth - 1);
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push({ ...this.current(), label: prev.label });
    this.restore(prev);
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push({ ...this.current(), label: next.label });
    this.restore(next);
    return true;
  }

  /** Save the pre-change state once per step (or once per group). */
  private record(label: string): void {
    if (this.groupDepth > 0) {
      if (this.groupRecorded) return;
      this.groupRecorded = true;
      label = this.groupLabel;
    }
    this.past.push({ ...this.current(), label: label || 'Change' });
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.future = [];
    this.syncHistoryLabels();
  }

  private current(): Omit<HistoryState, 'label'> {
    return { entities: this.entities(), edges: this.edges(), positions: this.positions() };
  }

  private restore(s: HistoryState): void {
    this.entities.set(s.entities);
    this.edges.set(s.edges);
    this.positions.set(s.positions);
    if (!s.entities.has(this.selectedId() ?? '')) this.selectedId.set(null);
    if (!s.edges.has(this.selectedEdgeId() ?? '')) this.selectedEdgeId.set(null);
    this.selectedIds.update((ids) => ids.filter((id) => s.entities.has(id)));
    this.dirty.set(true);
    this.syncHistoryLabels();
  }

  private syncHistoryLabels(): void {
    this.undoLabel.set(this.past.at(-1)?.label ?? null);
    this.redoLabel.set(this.future.at(-1)?.label ?? null);
  }

  private clearHistory(): void {
    this.past = [];
    this.future = [];
    this.groupDepth = 0;
    this.syncHistoryLabels();
  }

  reset(name = DEFAULT_CASE_NAME): void {
    this.clearHistory();
    this.entities.set(new Map());
    this.edges.set(new Map());
    this.positions.set(new Map());
    this.selectedId.set(null);
    this.selectedEdgeId.set(null);
    this.selectedIds.set([]);
    this.caseName.set(name);
    this.dirty.set(false);
  }

  snapshot(): CaseSnapshot {
    return {
      format: CASE_FORMAT,
      version: CASE_FORMAT_VERSION,
      name: this.caseName(),
      entities: [...this.entities().values()],
      edges: [...this.edges().values()],
      positions: Object.fromEntries(this.positions()),
    };
  }

  load(snap: CaseSnapshot): void {
    if (snap.format !== CASE_FORMAT && !LEGACY_CASE_FORMATS.includes(snap.format)) throw new Error('Not a libreOSINT case');
    if (snap.version > CASE_FORMAT_VERSION) throw new Error(`Case format v${snap.version} is newer than this app`);
    this.clearHistory();
    this.entities.set(new Map(snap.entities.map((e) => [e.id, e])));
    this.edges.set(new Map(snap.edges.map((e) => [e.id, e])));
    this.positions.set(new Map(Object.entries(snap.positions ?? {})));
    this.selectedId.set(null);
    this.selectedEdgeId.set(null);
    this.selectedIds.set([]);
    this.caseName.set(snap.name || DEFAULT_CASE_NAME);
    this.dirty.set(false);
  }

  private setEntity(e: Entity): void {
    this.entities.update((m) => new Map(m).set(e.id, e));
    this.dirty.set(true);
  }
}
