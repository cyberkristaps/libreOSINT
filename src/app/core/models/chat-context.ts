// Pure helpers that turn graph state + registered transforms into the Ollama system prompt and tool list.
import { Edge, Entity, ENTITY_TYPES, EntityType } from './entity';
import { TransformManifestEntry } from './transform';
import { suggestEdgeLabels } from './edge-labels';

/** Tool rounds per request in quick mode; thorough mode allows more and checks coverage before finishing. */
export const MAX_TOOL_STEPS = 5;
export const MAX_TOOL_STEPS_THOROUGH = 15;
/** How often one request may be sent back to follow unchecked leads. */
export const MAX_COVERAGE_NUDGES = 2;
const MAX_GAPS = 8;
export const CREATE_TOOL = 'create_or_link_entity';
export const NOTE_TOOL = 'append_entity_note';

const MAX_GRAPH_ENTITIES = 80;
const MAX_GRAPH_EDGES = 80;
const MAX_NOTE_CHARS = 600;
const MAX_PROPS_CHARS = 600;

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface GraphView {
  entities: ReadonlyMap<string, Entity>;
  edges: ReadonlyMap<string, Edge>;
  selectedIds: readonly string[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s);

function describeEntity(e: Entity, edges: ReadonlyMap<string, Edge>, entities: ReadonlyMap<string, Entity>): string {
  const lines = [`- id=${e.id} | ${e.type} | ${JSON.stringify(e.value)}`];
  if (e.tags.length) lines.push(`  tags: ${e.tags.join(', ')}`);
  const props = JSON.stringify(e.properties);
  if (props !== '{}') lines.push(`  properties: ${clip(props, MAX_PROPS_CHARS)}`);
  if (e.notes.trim()) lines.push(`  notes: ${clip(e.notes.trim().replace(/\n+/g, ' ⏎ '), MAX_NOTE_CHARS)}`);
  const links: string[] = [];
  for (const edge of edges.values()) {
    if (edge.source_id === e.id) links.push(`—${edge.label}→ ${entities.get(edge.target_id)?.value ?? '?'}`);
    if (edge.target_id === e.id) links.push(`←${edge.label}— ${entities.get(edge.source_id)?.value ?? '?'}`);
  }
  if (links.length) lines.push(`  links: ${links.slice(0, 20).join('; ')}${links.length > 20 ? ` (+${links.length - 20} more)` : ''}`);
  return lines.join('\n');
}

/** Concise graph summary: counts by type, then id | type | value and value —label→ value lines. */
export function summarizeGraph(view: GraphView): string {
  const { entities, edges } = view;
  if (entities.size === 0) return 'The graph is empty.';
  const counts = new Map<EntityType, number>();
  for (const e of entities.values()) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const byType = [...counts].map(([t, n]) => `${t}: ${n}`).join(', ');
  const ents = [...entities.values()];
  const entLines = ents.slice(0, MAX_GRAPH_ENTITIES).map((e) => `- ${e.id} | ${e.type} | ${e.value}`);
  if (ents.length > MAX_GRAPH_ENTITIES) entLines.push(`- … ${ents.length - MAX_GRAPH_ENTITIES} more entities not listed`);
  const eds = [...edges.values()];
  const edgeLines = eds
    .slice(0, MAX_GRAPH_EDGES)
    .map((e) => `- ${entities.get(e.source_id)?.value ?? '?'} —${e.label}→ ${entities.get(e.target_id)?.value ?? '?'}`);
  if (eds.length > MAX_GRAPH_EDGES) edgeLines.push(`- … ${eds.length - MAX_GRAPH_EDGES} more links not listed`);
  return [
    `${entities.size} entities (${byType}), ${edges.size} links.`,
    'Entities (id | type | value):',
    ...entLines,
    ...(edgeLines.length ? ['Links:', ...edgeLines] : []),
  ].join('\n');
}

const DIRECTION_EXAMPLES = (
  [
    ['Organization', 'Person'],
    ['Person', 'Organization'],
    ['Person', 'Social_Account'],
    ['Organization', 'Domain'],
    ['Domain', 'Subdomain'],
    ['Domain', 'IPv4'],
    ['IPv4', 'Organization'],
  ] as [EntityType, EntityType][]
)
  .map(([a, b]) => `${a}→${b}: ${suggestEdgeLabels(a, b)[0]}`)
  .join('; ');

export function buildSystemPrompt(view: GraphView, opts: { autoApply: boolean; transforms: TransformManifestEntry[]; now?: Date }): string {
  const empty = view.entities.size === 0;
  const selected = view.selectedIds.map((id) => view.entities.get(id)).filter((e): e is Entity => !!e);
  const lookups = opts.transforms.map((t) => t.id).join(', ') || 'none (desktop app not running)';
  return [
    'You are the AI Investigator inside libreOSINT, a local-first OSINT link-analysis workbench used by an independent security researcher.',
    `Current time: ${(opts.now ?? new Date()).toISOString()}.`,
    '',
    '## How to work',
    `- Use the lookup tools (${lookups}) to gather facts. Never invent results. If a lookup fails or returns nothing, say so — that is NOT evidence that nothing exists.`,
    opts.autoApply
      ? `- Lookup results are added to the graph automatically (with ids in the tool result); do not re-add them. Use ${CREATE_TOOL} for findings the lookups did not add (e.g. people, accounts or emails you read in search results or page text).`
      : `- Add relevant findings with ${CREATE_TOOL}, linking each new entity from the entity it relates to (source_id).`,
    `- source_id and entity_id accept an entity id or the entity's exact value.`,
    ...(empty ? [`- The graph is EMPTY: first add the main subject with ${CREATE_TOOL} (no source_id), then link everything else from it.`] : []),
    `- edge_label reads as "<source> <edge_label> <new entity>", so pick the label for THAT direction: ${DIRECTION_EXAMPLES}.`,
    `- Record conclusions, evidence and source URLs with ${NOTE_TOOL} on the most relevant entity.`,
    '- Use entity ids exactly as listed below. Prefer the selected entities as the starting point.',
    '- For broad requests ("find everything", people, founders, news, social media), dig: run registration, DNS, certificate and news lookups, and several web searches with targeted queries (founder/team, LinkedIn, Facebook/Instagram/X, interviews). Then follow the leads you find (usernames, names, pages). Call several tools in one step when they are independent.',
    `- Read titles, snippets and page text in results. Add every person, organization, social account or email you identify with ${CREATE_TOOL}, linked to what it relates to, with the source URL in properties.`,
    '- Finish with a short summary: what you found, what you added, and what is still unknown.',
    opts.autoApply
      ? '- Graph changes are applied immediately.'
      : `- REVIEW MODE: graph changes are NOT applied; each ${CREATE_TOOL} / ${NOTE_TOOL} call becomes a proposal the user reviews. The tool returns a proposal_id you may use as source_id or entity_id in later proposals.`,
    '',
    `## Selected entities (${selected.length})`,
    selected.length ? selected.map((e) => describeEntity(e, view.edges, view.entities)).join('\n') : 'None selected.',
    '',
    '## Graph summary',
    summarizeGraph(view),
  ].join('\n');
}

/** Ollama tool definitions: one per registered transform plus the two graph-mutation tools. */
/** A lookup that takes any entity type takes a free-text query (web search, news search). */
export function isFreeTextTransform(t: Pick<TransformManifestEntry, 'input_types'>): boolean {
  return ENTITY_TYPES.every((type) => t.input_types.includes(type));
}

export function buildTools(transforms: TransformManifestEntry[], opts: { autoApply?: boolean } = {}): OllamaTool[] {
  const lookupTools: OllamaTool[] = transforms.map((t) => {
    const anyType = isFreeTextTransform(t);
    return {
      type: 'function',
      function: {
        name: t.id,
        description: opts.autoApply
          ? `${t.description} Results are added to the graph automatically, linked from the looked-up entity, and returned to you with their entity ids.`
          : `${t.description} Read-only lookup: results come back to you and are NOT added to the graph.`,
        parameters: {
          type: 'object',
          properties: {
            value: {
              type: 'string',
              description: anyType
                ? 'Free-text search query, e.g. "example.com founders". Results attach to the graph entity the query mentions.'
                : `The ${t.input_types.join(' / ')} to look up, e.g. "example.com".`,
            },
            entity_type: {
              type: 'string',
              enum: t.input_types,
              description: anyType
                ? 'Optional. Only when the query is exactly one entity value: its type.'
                : `Type of value (default ${t.input_types[0]}).`,
            },
          },
          required: ['value'],
        },
      },
    };
  });
  return [
    ...lookupTools,
    {
      type: 'function',
      function: {
        name: CREATE_TOOL,
        description:
          'Add an entity to the investigation graph (or update it if the same type+value exists) and optionally link it from an existing entity. Use for every relevant finding.',
        parameters: {
          type: 'object',
          properties: {
            source_id: { type: 'string', description: 'Entity to link from: its id, its exact value, or a proposal_id. Omit for an unlinked entity.' },
            edge_label: {
              type: 'string',
              description: 'snake_case relationship read as "<source> <edge_label> <new entity>", e.g. Organization→Person: employs, Person→Organization: works_at, Domain→IPv4: resolves_to.',
            },
            entity_type: { type: 'string', enum: [...ENTITY_TYPES] },
            value: { type: 'string', description: 'Canonical value, e.g. "sub.example.com", "192.0.2.1", "Jane Doe".' },
            properties: { type: 'object', description: 'Key/value facts about the entity (source URL, dates, ...).' },
            initial_note: { type: 'string', description: 'Optional Markdown note explaining why this entity matters, with sources.' },
          },
          required: ['entity_type', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: NOTE_TOOL,
        description: 'Append a timestamped [AI Finding] Markdown note to an entity, e.g. a conclusion with evidence and source URLs.',
        parameters: {
          type: 'object',
          properties: {
            entity_id: { type: 'string', description: 'Entity to annotate: its id, its exact value, or a proposal_id.' },
            note_markdown: { type: 'string', description: 'The finding, in Markdown.' },
          },
          required: ['entity_id', 'note_markdown'],
        },
      },
    },
  ];
}


// --- coverage check (thorough mode) ------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}]/u;
const HOST_TYPES: EntityType[] = ['Domain', 'Subdomain'];

/** "kiberzona.lv" -> "kiberzona": the name people write in text and searches. */
export function domainName(value: string): string {
  const labels = value.trim().toLowerCase().replace(/\.$/, '').split('.');
  return labels.length > 1 ? labels.slice(0, -1).join('.') : labels[0];
}

function mentions(text: string, needle: string): boolean {
  if (needle.length < 3) return false;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    const before = text[i - 1];
    const after = text[i + needle.length];
    if ((!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after))) return true;
  }
  return false;
}

/**
 * Graph entities that `text` names, best match first (longest). A domain also matches by its name without
 * the TLD, so "kiberzona founders" finds kiberzona.lv.
 */
export function mentionedEntities(text: string, entities: Iterable<Entity>): Entity[] {
  const t = text.toLowerCase();
  const found: [Entity, number][] = [];
  for (const e of entities) {
    if (e.type === 'Collection') continue;
    const v = e.value.trim().toLowerCase();
    const names = HOST_TYPES.includes(e.type) ? [v, domainName(v)] : [v];
    const hit = names.find((n) => n !== t && mentions(t, n));
    if (hit) found.push([e, hit.length]);
  }
  return found.sort((a, b) => b[1] - a[1]).map(([e]) => e);
}

/** Key for "this lookup already ran on this entity / with this query". */
export const ranKey = (transformId: string, subject: string) => `${transformId}|${subject.trim().toLowerCase()}`;

const SEARCH_TEMPLATES: Partial<Record<EntityType, string[]>> = {
  Domain: ['{name}', '{name} founder', '{name} team', '{name} linkedin', '{name} facebook instagram'],
  Subdomain: ['{name}'],
  Organization: ['{value}', '{value} founder', '{value} linkedin', '{value} facebook instagram'],
  Person: ['"{value}"', '{value} linkedin', '{value} x.com twitter'],
};
const LEAD_TYPES: EntityType[] = ['Person', 'Organization', 'Social_Account', 'Alias', 'Email'];

export interface CoverageInput {
  /** What the request is about: selected entities and entities the request names. */
  subjects: readonly Entity[];
  /** Findings the AI added this turn (people, accounts, …) that may deserve their own lookups. */
  leads: readonly Entity[];
  transforms: readonly TransformManifestEntry[];
  /** ranKey()s of lookups already run (this turn, by id/value and by search query). */
  ran: ReadonlySet<string>;
  edges: ReadonlyMap<string, Edge>;
}

/**
 * Lookups a thorough investigation would still run, as ready-to-call lines for the model.
 * Small models stop after the first result; this list is what the app sends them back with.
 */
export function coverageGaps(input: CoverageInput): string[] {
  const { transforms, ran, edges } = input;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (transformId: string, value: string) => {
    const key = ranKey(transformId, value);
    if (ran.has(key) || seen.has(key) || !transforms.some((t) => t.id === transformId)) return;
    seen.add(key);
    out.push(`${transformId} value=${JSON.stringify(value)}`);
  };
  const ranBefore = (e: Entity, transformId: string) =>
    ran.has(ranKey(transformId, e.id)) ||
    ran.has(ranKey(transformId, e.value)) ||
    [...edges.values()].some((x) => x.source_id === e.id && x.transform_source === transformId);

  for (const e of input.subjects) {
    for (const t of transforms) {
      if (isFreeTextTransform(t) || !t.input_types.includes(e.type) || ranBefore(e, t.id)) continue;
      add(t.id, e.value);
    }
    const name = HOST_TYPES.includes(e.type) ? domainName(e.value) : e.value;
    if (!ranBefore(e, 'news_search')) add('news_search', name);
    for (const tpl of SEARCH_TEMPLATES[e.type] ?? ['{value}']) {
      add('web_search', tpl.replace('{name}', name).replace('{value}', e.value));
    }
  }
  for (const e of input.leads) {
    if (!LEAD_TYPES.includes(e.type)) continue;
    if (e.type === 'Social_Account' || e.type === 'Alias') {
      const handle = e.value.replace(/^@/, '').split(/[/@]/).filter(Boolean).pop() ?? e.value;
      if (!ranBefore(e, 'username_to_accounts')) add('username_to_accounts', handle);
    } else if (e.type !== 'Email' && !ranBefore(e, 'web_search')) {
      add('web_search', `"${e.value}"`);
    }
  }
  return out.slice(0, MAX_GAPS);
}

/** The message that sends the model back to work when it tries to finish with leads unchecked. */
export function coverageNudge(gaps: readonly string[]): string {
  return [
    'Not finished: this is a thorough investigation and these lookups have not been run yet:',
    ...gaps.map((g) => `- ${g}`),
    `Run them now (several tool calls in one step is fine). From the results, add every person, organization, social account or email you can identify with ${CREATE_TOOL}, linked to the entity it relates to, with the source URL in properties. If a lookup is clearly irrelevant, skip it. Then give the final summary.`,
  ].join('\n');
}
