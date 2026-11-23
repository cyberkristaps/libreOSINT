// Pure helpers that turn graph state + registered transforms into the Ollama system prompt and tool list.
import { Edge, Entity, ENTITY_TYPES, EntityType } from './entity';
import { TransformManifestEntry } from './transform';
import { suggestEdgeLabels } from './edge-labels';

export const MAX_TOOL_STEPS = 5;
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
    '- Be concise. Finish with a short summary of what you found and what you added.',
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
export function buildTools(transforms: TransformManifestEntry[], opts: { autoApply?: boolean } = {}): OllamaTool[] {
  const lookupTools: OllamaTool[] = transforms.map((t) => {
    const anyType = t.input_types.length === ENTITY_TYPES.length;
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
              description: anyType ? 'Free-text query.' : `The ${t.input_types.join(' / ')} to look up, e.g. "example.com".`,
            },
            entity_type: { type: 'string', enum: t.input_types, description: `Type of value (default ${t.input_types[0]}).` },
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
