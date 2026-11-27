import { Position } from './case';

/**
 * "Tidy" layout: each connected group of entities becomes a mind map. The entity the investigation started
 * from (the oldest one) sits in the middle, its branches go out to the left and right, and every branch's
 * results stack in columns beside it. Pure and deterministic, so the same graph always lands the same way and
 * re-tidying after a lookup only shifts what the new results need.
 */

export interface TidyNode {
  id: string;
  created_at: string;
}

export interface TidyEdge {
  source_id: string;
  target_id: string;
}

/** Horizontal distance between a node and its children (labels are up to 160 px wide). */
export const COL = 240;
/** Vertical distance between stacked siblings (node + label below it). */
export const ROW = 56;
/** More leaves than this under one node wrap into extra columns instead of one very tall column. */
export const MAX_LEAF_ROWS = 10;
const LEAF_COL = 220;
const GAP = 120;
const MAX_ROW_WIDTH = 1600;
/** Half a label's width / a label's height: keeps neighbouring components from touching. */
const PAD_X = 90;
const PAD_Y = 30;

export function tidyLayout(nodes: readonly TidyNode[], edges: readonly TidyEdge[]): Map<string, Position> {
  // Oldest first; ties by id so the order never depends on insertion order.
  const ordered = [...nodes].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const rank = new Map(ordered.map((n, i) => [n.id, i]));
  const adj = new Map<string, string[]>(ordered.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e.source_id === e.target_id || !adj.has(e.source_id) || !adj.has(e.target_id)) continue;
    adj.get(e.source_id)!.push(e.target_id);
    adj.get(e.target_id)!.push(e.source_id);
  }
  for (const list of adj.values()) list.sort((a, b) => rank.get(a)! - rank.get(b)!);

  const seen = new Set<string>();
  const components: Map<string, Position>[] = [];
  for (const n of ordered) {
    if (seen.has(n.id)) continue;
    components.push(layoutComponent(n.id, adj, seen));
  }
  return pack(components);
}

/** Breadth-first spanning tree from `root`, laid out as a two-sided mind map centred on (0, 0). */
function layoutComponent(root: string, adj: Map<string, string[]>, seen: Set<string>): Map<string, Position> {
  const children = new Map<string, string[]>();
  seen.add(root);
  const queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    const kids: string[] = [];
    for (const nb of adj.get(id)!) {
      if (seen.has(nb)) continue;
      seen.add(nb);
      kids.push(nb);
      queue.push(nb);
    }
    children.set(id, kids);
  }

  const heights = new Map<string, number>();
  const isLeaf = (id: string) => !children.get(id)!.length;
  const gridRows = (kids: string[]) => {
    const cols = Math.ceil(kids.length / MAX_LEAF_ROWS);
    return Math.ceil(kids.length / cols);
  };
  const usesGrid = (kids: string[]) => kids.length > MAX_LEAF_ROWS && kids.every(isLeaf);
  const height = (id: string): number => {
    const cached = heights.get(id);
    if (cached !== undefined) return cached;
    const kids = children.get(id)!;
    const h = !kids.length ? ROW : usesGrid(kids) ? gridRows(kids) * ROW : kids.reduce((s, k) => s + height(k), 0);
    heights.set(id, h);
    return h;
  };

  const pos = new Map<string, Position>();
  /** Lay out the children of a node at (x, y) on one side, in a band starting at `top`. */
  const placeKids = (kids: string[], x: number, top: number, side: 1 | -1) => {
    if (usesGrid(kids)) {
      const rows = gridRows(kids);
      kids.forEach((k, i) => {
        const col = Math.floor(i / rows);
        pos.set(k, { x: x + side * (COL + col * LEAF_COL), y: top + (i % rows) * ROW + ROW / 2 });
      });
      return;
    }
    let y = top;
    for (const k of kids) {
      place(k, x + side * COL, y, side);
      y += height(k);
    }
  };
  const place = (id: string, x: number, top: number, side: 1 | -1) => {
    const kids = children.get(id)!;
    if (!kids.length) {
      pos.set(id, { x, y: top + ROW / 2 });
      return;
    }
    placeKids(kids, x, top, side);
    pos.set(id, { x, y: top + height(id) / 2 });
  };

  // Split the root's branches between right and left so the map stays balanced around it.
  const kids = children.get(root)!;
  const total = kids.reduce((s, k) => s + height(k), 0);
  const right: string[] = [];
  const left: string[] = [];
  let acc = 0;
  for (const k of kids) {
    if (kids.length > 2 && acc >= total / 2) left.push(k);
    else right.push(k);
    acc += height(k);
  }
  pos.set(root, { x: 0, y: 0 });
  const band = (list: string[]) => list.reduce((s, k) => s + height(k), 0);
  // Each side is centred on the root; a side of many plain links wraps into columns (see placeKids).
  placeKids(right, 0, -band(right) / 2, 1);
  placeKids(left, 0, -band(left) / 2, -1);
  return pos;
}

/** Place components left to right in rows, oldest first, without overlaps. */
function pack(components: Map<string, Position>[]): Map<string, Position> {
  const out = new Map<string, Position>();
  const boxes = components.map((c) => {
    const xs = [...c.values()].map((p) => p.x);
    const ys = [...c.values()].map((p) => p.y);
    const x1 = Math.min(...xs) - PAD_X;
    const y1 = Math.min(...ys) - PAD_Y;
    return { c, x1, y1, w: Math.max(...xs) + PAD_X - x1, h: Math.max(...ys) + PAD_Y + PAD_Y - y1 };
  });
  const maxWidth = Math.max(MAX_ROW_WIDTH, ...boxes.map((b) => b.w));
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > maxWidth) {
      x = 0;
      y += rowH + GAP;
      rowH = 0;
    }
    for (const [id, p] of b.c) out.set(id, { x: Math.round(p.x - b.x1 + x), y: Math.round(p.y - b.y1 + y) });
    x += b.w + GAP;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}
