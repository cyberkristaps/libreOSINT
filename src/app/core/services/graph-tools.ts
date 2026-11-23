import { Injectable, inject } from '@angular/core';
import { Entity, EntityType, isEntityType } from '../models/entity';
import { normalizeValue } from '../models/normalize';
import { DEFAULT_EDGE_LABEL, toEdgeLabel } from '../models/edge-labels';
import { AppendNoteArgs, CreateOrLinkArgs } from '../models/chat';
import { INPUT_REF, TransformResponse } from '../models/transform';
import { Position } from '../models/case';
import { GraphStore } from './graph-store';

export const AI_TAG = 'ai-investigator';

export interface CreateOrLinkResult {
  entity_id: string;
  created: boolean;
  edge_id?: string;
  edge_label?: string;
  /** Set when the entity was added but could not be linked. */
  warning?: string;
}

export interface IngestResult {
  created: number;
  merged: number;
  edges: number;
  /** Transform ref → graph entity id. */
  ids: Record<string, string>;
}

/** Format a timestamped finding block for an entity's notes. */
export function aiFinding(markdown: string, at = new Date()): string {
  return `**[AI Finding]** ${at.toISOString()}\n\n${markdown.trim()}`;
}

function appendBlock(notes: string, block: string): string {
  return notes.trim() ? `${notes.trimEnd()}\n\n---\n\n${block}` : block;
}

/**
 * Graph mutations shared by the AI investigator and manual transform runs.
 * Everything goes through GraphStore, so the standard dedup rules apply.
 */
@Injectable({ providedIn: 'root' })
export class GraphTools {
  private readonly store = inject(GraphStore);

  /**
   * Find an entity by id, or by value (models often pass the value they see instead of the id).
   * Value matching uses the dedup normalization of each entity's type, so `Kiberzona.lv.` finds `kiberzona.lv`.
   */
  findEntity(ref: string | undefined, type?: EntityType): Entity | undefined {
    if (!ref) return undefined;
    const byId = this.store.entities().get(ref);
    if (byId && (!type || byId.type === type)) return byId;
    const candidates = [...this.store.entities().values()].filter((e) => !type || e.type === type);
    const exact = candidates.find((e) => e.value === ref.trim());
    if (exact) return exact;
    return candidates.find((e) => {
      try {
        return normalizeValue(e.type, ref) === normalizeValue(e.type, e.value);
      } catch {
        return false;
      }
    });
  }

  /** `create_or_link_entity` tool. Throws Error with a model-readable message on bad input. */
  createOrLink(args: CreateOrLinkArgs, opts: { tag?: string; transformSource?: string } = {}): CreateOrLinkResult {
    return this.store.group(`AI: add ${args.entity_type} ${args.value}`, () => this.createOrLinkInner(args, opts));
  }

  private createOrLinkInner(args: CreateOrLinkArgs, opts: { tag?: string; transformSource?: string }): CreateOrLinkResult {
    const tag = opts.tag ?? AI_TAG;
    if (!isEntityType(String(args.entity_type))) throw new Error(`unknown entity_type "${args.entity_type}"`);
    if (typeof args.value !== 'string' || !args.value.trim()) throw new Error('value is required');
    const source = this.findEntity(args.source_id);

    const { entity, created } = this.store.upsertEntity(
      { type: args.entity_type, value: args.value, properties: sanitizeProps(args.properties), tags: [tag] },
      source ? this.positionNear(source) : undefined,
    );
    if (args.initial_note?.trim()) {
      const block = aiFinding(args.initial_note);
      this.store.updateEntity(entity.id, { notes: appendBlock(this.store.entities().get(entity.id)!.notes, block) });
    }
    const result: CreateOrLinkResult = { entity_id: entity.id, created };
    // A model naming the entity itself as its source (common on an empty graph) is not a missing link.
    if (args.source_id && !source && this.findEntity(args.source_id)?.id !== entity.id) {
      // Never drop a finding because its source is missing: add it unlinked and tell the model.
      result.warning = `source "${args.source_id}" is not on the graph, so the entity was added without a link. Add the source first (create_or_link_entity without source_id), then link to it by id or value.`;
    }
    if (source && source.id !== entity.id) {
      const label = toEdgeLabel(args.edge_label ?? '') ?? DEFAULT_EDGE_LABEL;
      const edge = this.store.upsertEdge(source.id, entity.id, label, opts.transformSource ?? tag);
      result.edge_id = edge.id;
      result.edge_label = label;
    }
    return result;
  }

  /** `append_entity_note` tool. */
  appendNote(args: AppendNoteArgs): { entity_id: string; notes_length: number } {
    const e = this.findEntity(args.entity_id);
    if (!e) throw new Error(`entity "${args.entity_id}" is not on the graph (use its id or exact value; create it first if needed)`);
    if (!args.note_markdown?.trim()) throw new Error('note_markdown is empty');
    const notes = appendBlock(e.notes, aiFinding(args.note_markdown));
    this.store.updateEntity(e.id, { notes, tags: [...new Set([...e.tags, AI_TAG])] }, `AI note on ${e.value}`);
    return { entity_id: e.id, notes_length: notes.length };
  }

  /** Add a transform's output to the graph around `sourceId` (manual "Run lookup"). */
  ingestTransform(sourceId: string, transformId: string, resp: TransformResponse): IngestResult {
    return this.store.group(`Lookup ${transformId}`, () => this.ingestInner(sourceId, transformId, resp));
  }

  private ingestInner(sourceId: string, transformId: string, resp: TransformResponse): IngestResult {
    const source = this.store.entities().get(sourceId);
    if (!source) throw new Error('source entity no longer exists');
    const refToId = new Map<string, string>([[INPUT_REF, source.id]]);
    let created = 0;
    let merged = 0;
    for (const out of resp.entities) {
      try {
        // No position: the canvas places the whole batch around its linked source once the edges exist.
        const r = this.store.upsertEntity({ type: out.type, value: out.value, properties: sanitizeProps(out.properties), tags: out.tags });
        refToId.set(out.ref, r.entity.id);
        if (r.created) created++;
        else merged++;
      } catch {
        /* invalid value from the transform: skip it */
      }
    }
    let edges = 0;
    for (const e of resp.edges ?? resp.entities.map((x) => ({ source: INPUT_REF, target: x.ref, label: DEFAULT_EDGE_LABEL }))) {
      const s = refToId.get(e.source);
      const t = refToId.get(e.target);
      if (s && t && s !== t) {
        this.store.upsertEdge(s, t, toEdgeLabel(e.label) ?? DEFAULT_EDGE_LABEL, transformId);
        edges++;
      }
    }
    return { created, merged, edges, ids: Object.fromEntries([...refToId].filter(([ref]) => ref !== INPUT_REF)) };
  }

  /** Spread new nodes on a ring around their source so they don't stack. */
  private positionNear(source: Entity): Position | undefined {
    const center = this.store.positions().get(source.id);
    if (!center) return undefined;
    const n = this.store.linksOf(source.id).outgoing.length + this.store.linksOf(source.id).incoming.length;
    const ring = 140 + Math.floor(n / 12) * 70;
    const angle = (n % 12) * ((2 * Math.PI) / 12) + Math.floor(n / 12) * 0.26;
    return { x: center.x + ring * Math.cos(angle), y: center.y + ring * Math.sin(angle) };
  }
}

/** Keep only JSON-safe, reasonably sized properties coming from a model or transform. */
function sanitizeProps(props: unknown): Record<string, never> {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>).slice(0, 50)) {
    if (v === undefined || typeof v === 'function') continue;
    const json = JSON.stringify(v);
    if (json && json.length <= 4000) out[k.slice(0, 80)] = v;
  }
  return out as Record<string, never>;
}
