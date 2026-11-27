import { COL, MAX_LEAF_ROWS, ROW, tidyLayout } from './tidy-layout';

const node = (id: string, minute = 0) => ({ id, created_at: `2026-11-27T10:${String(minute).padStart(2, '0')}:00Z` });
const edge = (source_id: string, target_id: string) => ({ source_id, target_id });

function minDistance(pos: Map<string, { x: number; y: number }>): number {
  const ps = [...pos.values()];
  let min = Infinity;
  for (let i = 0; i < ps.length; i++)
    for (let j = i + 1; j < ps.length; j++) min = Math.min(min, Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y));
  return min;
}

describe('tidyLayout', () => {
  // A domain with three branches (5 site pages, 2 apps, 2 other sites) plus one direct link.
  const nodes = [node('root', 0), node('site', 1), node('apps', 1), node('other', 1), node('yt', 2)];
  const edges = [edge('root', 'site'), edge('root', 'apps'), edge('root', 'other'), edge('root', 'yt')];
  for (let i = 0; i < 5; i++) (nodes.push(node(`s${i}`, 3)), edges.push(edge('site', `s${i}`)));
  for (let i = 0; i < 2; i++) (nodes.push(node(`a${i}`, 3)), edges.push(edge('apps', `a${i}`)));
  for (let i = 0; i < 2; i++) (nodes.push(node(`o${i}`, 3)), edges.push(edge('other', `o${i}`)));

  it('places every node without overlaps', () => {
    const pos = tidyLayout(nodes, edges);
    expect(pos.size).toBe(nodes.length);
    expect(minDistance(pos)).toBeGreaterThanOrEqual(ROW);
  });

  it('puts the oldest entity in the middle and its branches on both sides', () => {
    const pos = tidyLayout(nodes, edges);
    const root = pos.get('root')!;
    const branchXs = ['site', 'apps', 'other', 'yt'].map((id) => pos.get(id)!.x - root.x);
    expect(branchXs.every((dx) => Math.abs(dx) === COL)).toBe(true);
    expect(branchXs.some((dx) => dx > 0) && branchXs.some((dx) => dx < 0)).toBe(true);
  });

  it('stacks a branch’s results beside it, centred on the branch', () => {
    const pos = tidyLayout(nodes, edges);
    const site = pos.get('site')!;
    const kids = [0, 1, 2, 3, 4].map((i) => pos.get(`s${i}`)!);
    expect(new Set(kids.map((k) => k.x)).size).toBe(1);
    expect(Math.abs(kids[0].x - site.x)).toBe(COL);
    expect((kids[0].y + kids[4].y) / 2).toBeCloseTo(site.y);
  });

  it('wraps a long list of results into columns', () => {
    const n = [node('news', 0)];
    const e = [];
    for (let i = 0; i < 25; i++) (n.push(node(`n${i}`, 1)), e.push(edge('news', `n${i}`)));
    const pos = tidyLayout(n, e);
    const perColumn = new Map<number, number>();
    for (const [id, p] of pos) if (id !== 'news') perColumn.set(p.x, (perColumn.get(p.x) ?? 0) + 1);
    expect(Math.max(...perColumn.values())).toBeLessThanOrEqual(MAX_LEAF_ROWS);
    expect(perColumn.size).toBeGreaterThan(2);
    expect(minDistance(pos)).toBeGreaterThanOrEqual(ROW);
  });

  it('keeps separate groups and lone entities apart', () => {
    const pos = tidyLayout([...nodes, node('lonely', 5), node('p', 6), node('q', 6)], [...edges, edge('p', 'q')]);
    expect(minDistance(pos)).toBeGreaterThanOrEqual(ROW);
  });

  it('is deterministic whatever order the graph lists things in', () => {
    const a = tidyLayout(nodes, edges);
    const b = tidyLayout([...nodes].reverse(), [...edges].reverse());
    expect([...b].sort()).toEqual([...a].sort());
  });

  it('survives cycles, self-links and links to missing entities', () => {
    const pos = tidyLayout([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('a', 'a'), edge('a', 'zz')]);
    expect(pos.size).toBe(3);
    expect(tidyLayout([], []).size).toBe(0);
  });
});
