import { TestBed } from '@angular/core/testing';
import { ChatService } from './chat';
import { ChatSettings } from './chat-settings';
import { GraphStore } from './graph-store';
import { BridgeError, TauriBridge } from './tauri-bridge';
import { NetworkSettings } from './network-settings';
import { TransformService } from './transform-service';
import { ConsoleLog } from './console-log';
import { TransformManifestEntry, TransformResponse } from '../models/transform';
import { AI_TAG } from './graph-tools';
import { MAX_COVERAGE_NUDGES, MAX_TOOL_STEPS, MAX_TOOL_STEPS_THOROUGH, buildSystemPrompt } from '../models/chat-context';
import { ENTITY_TYPES } from '../models/entity';

const DNS: TransformManifestEntry = {
  id: 'domain_to_dns',
  name: 'DNS',
  description: 'Resolve DNS records.',
  command: ['python3', 'domain_to_dns.py'],
  input_types: ['Domain', 'Subdomain'],
  output_types: ['IPv4'],
  timeout_s: 30,
  rate_limit: { max_concurrent: 1, min_interval_ms: 0 },
  requires_keys: [],
};

const WEB: TransformManifestEntry = { ...DNS, id: 'web_search', name: 'Web search', input_types: [...ENTITY_TYPES], output_types: ['URL'] };

type Reply = { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } });

class FakeBridge {
  isTauri = true;
  replies: Reply[] = [];
  requests: Record<string, unknown>[] = [];
  transformCalls: { id: string; value: string; type: string }[] = [];
  transformParams: (Record<string, unknown> | undefined)[] = [];
  manifest: TransformManifestEntry[] = [DNS];
  cancelled: string[] = [];
  transformImpl: () => Promise<TransformResponse> = async () => ({
    contract_version: 1,
    entities: [{ ref: 'e1', type: 'IPv4', value: '192.0.2.1', properties: { ttl: 60 } }],
    edges: [{ source: '$input', target: 'e1', label: 'resolves_to' }],
    messages: [],
  });

  async ollamaChat(_job: string, _url: string, body: Record<string, unknown>) {
    this.requests.push(structuredClone(body));
    const next = this.replies.shift() ?? { content: 'done' };
    return { message: { role: 'assistant', content: next.content ?? '', tool_calls: next.tool_calls } };
  }
  async transformList() {
    return this.manifest;
  }
  logHandler?: (e: { job_id: string; transform_id: string; line: string }) => void;
  lastJob = '';
  async transformRun(job: string, id: string, entity: { value: string; type: string }, params?: Record<string, unknown>) {
    this.lastJob = job;
    this.transformCalls.push({ id, value: entity.value, type: entity.type });
    this.transformParams.push(params);
    return this.transformImpl();
  }
  async cancelJob(job: string) {
    this.cancelled.push(job);
  }
  async onTransformLog(handler: (e: { job_id: string; transform_id: string; line: string }) => void) {
    this.logHandler = handler;
    return () => undefined;
  }
}

describe('ChatService', () => {
  let chat: ChatService;
  let store: GraphStore;
  let settings: ChatSettings;
  let bridge: FakeBridge;

  beforeEach(() => {
    localStorage.clear();
    bridge = new FakeBridge();
    TestBed.configureTestingModule({ providers: [{ provide: TauriBridge, useValue: bridge }] });
    chat = TestBed.inject(ChatService);
    store = TestBed.inject(GraphStore);
    settings = TestBed.inject(ChatSettings);
    store.reset();
    settings.model.set('test-model');
    settings.autoApply.set(true);
  });

  const lastReply = () => chat.messages().at(-1)!;

  it('runs lookups and graph tools, then answers (auto-apply)', async () => {
    const domain = store.upsertEntity({ type: 'Domain', value: 'example.com' }, { x: 0, y: 0 }).entity;
    store.selectedIds.set([domain.id]);
    bridge.replies = [
      { tool_calls: [call('domain_to_dns', { value: 'example.com' })] },
      {
        tool_calls: [
          call('create_or_link_entity', { source_id: domain.id, edge_label: 'resolves to', entity_type: 'IPv4', value: '192.0.2.1', initial_note: 'Primary A record.' }),
          call('append_entity_note', { entity_id: domain.id, note_markdown: 'Hosted on **192.0.2.1**.' }),
        ],
      },
      { content: 'example.com resolves to 192.0.2.1.' },
    ];

    await chat.send('Investigate this domain');

    expect(bridge.transformCalls).toEqual([{ id: 'domain_to_dns', value: 'example.com', type: 'Domain' }]);
    const reply = lastReply();
    expect(reply.content).toBe('example.com resolves to 192.0.2.1.');
    expect(reply.meta?.status).toBe('done');
    expect(reply.meta?.steps.filter((s) => s.kind === 'tool').map((s) => [s.name, s.status])).toEqual([
      ['domain_to_dns', 'done'],
      ['create_or_link_entity', 'done'],
      ['append_entity_note', 'done'],
    ]);

    const ip = [...store.entities().values()].find((e) => e.type === 'IPv4')!;
    expect(ip.tags).toContain(AI_TAG);
    expect(ip.notes).toMatch(/^\*\*\[AI Finding\]\*\* \d{4}-\d\d-\d\dT.*\n\nPrimary A record\.$/);
    expect([...store.edges().values()][0]).toMatchObject({ source_id: domain.id, target_id: ip.id, label: 'resolves_to' });
    expect(store.entities().get(domain.id)!.notes).toContain('Hosted on **192.0.2.1**.');

    // Request shape: temperature 0, tools offered, selected entity in the system prompt, tool results fed back.
    const first = bridge.requests[0] as { options: { temperature: number }; tools: unknown[]; messages: { role: string; content: string }[] };
    expect(first.options.temperature).toBe(0);
    expect(first.tools.length).toBe(3);
    expect(first.messages[0].content).toContain(`id=${domain.id} | Domain | "example.com"`);
    const second = bridge.requests[1] as { messages: { role: string; content: string }[] };
    expect(second.messages.at(-1)).toMatchObject({ role: 'tool' });
    expect(second.messages.at(-1)!.content).toContain('192.0.2.1');
  });

  it('dedups AI-created entities against the graph', async () => {
    const existing = store.upsertEntity({ type: 'Domain', value: 'Example.com' }).entity;
    bridge.replies = [{ tool_calls: [call('create_or_link_entity', { entity_type: 'Domain', value: 'example.com.', properties: { registrar: 'X' } })] }, { content: 'ok' }];
    await chat.send('add it');
    expect(store.counts().entities).toBe(1);
    expect(store.entities().get(existing.id)!.properties).toEqual({ registrar: 'X' });
    expect(store.entities().get(existing.id)!.tags).toContain(AI_TAG);
  });

  it('review mode proposes instead of mutating, and applies chained proposals', async () => {
    settings.autoApply.set(false);
    const org = store.upsertEntity({ type: 'Organization', value: 'ACME' }).entity;
    bridge.replies = [
      {
        tool_calls: [
          call('create_or_link_entity', { source_id: org.id, edge_label: 'owns', entity_type: 'Domain', value: 'acme.example' }),
          call('create_or_link_entity', { source_id: 'proposal-1', edge_label: 'has_subdomain', entity_type: 'Subdomain', value: 'www.acme.example' }),
          call('append_entity_note', { entity_id: 'proposal-2', note_markdown: 'Main website.' }),
        ],
      },
      { content: 'Proposed 2 entities and a note.' },
    ];
    await chat.send('map ACME');

    expect(store.counts()).toEqual({ entities: 1, edges: 0 });
    const reply = lastReply();
    expect(reply.meta!.proposals.map((p) => [p.id, p.kind, p.status])).toEqual([
      ['proposal-1', 'entity', 'pending'],
      ['proposal-2', 'entity', 'pending'],
      ['proposal-3', 'note', 'pending'],
    ]);
    expect(chat.pendingProposals()).toBe(3);

    // Applying the note first pulls in the proposals it depends on.
    chat.applyProposal(reply.id, 'proposal-3');
    expect(store.counts()).toEqual({ entities: 3, edges: 2 });
    const www = [...store.entities().values()].find((e) => e.value === 'www.acme.example')!;
    expect(www.notes).toContain('Main website.');
    expect(lastReply().meta!.proposals.every((p) => p.status === 'applied')).toBe(true);
    expect(chat.pendingProposals()).toBe(0);
  });

  it('review mode: self-referencing or circular proposals fail cleanly', async () => {
    settings.autoApply.set(false);
    bridge.replies = [
      {
        tool_calls: [
          call('create_or_link_entity', { source_id: 'proposal-1', entity_type: 'Domain', value: 'self.example' }),
          call('create_or_link_entity', { source_id: 'proposal-3', entity_type: 'Domain', value: 'a.example' }),
          call('create_or_link_entity', { source_id: 'proposal-2', entity_type: 'Domain', value: 'b.example' }),
        ],
      },
      { content: 'Proposed.' },
    ];
    await chat.send('loop');
    const reply = lastReply();

    chat.applyAll(reply.id);
    expect(store.counts()).toEqual({ entities: 0, edges: 0 });
    const proposals = lastReply().meta!.proposals;
    expect(proposals.map((p) => p.status)).toEqual(['error', 'error', 'error']);
    expect(proposals[0].error).toContain('circular dependency on proposal-1');
  });

  it('stops tool calling after the step limit and asks for a summary without tools', async () => {
    settings.depth.set('quick');
    store.upsertEntity({ type: 'Domain', value: 'example.com' });
    bridge.replies = Array.from({ length: MAX_TOOL_STEPS }, () => ({ tool_calls: [call('domain_to_dns', { value: 'example.com' })] }));
    bridge.replies.push({ content: 'Summary.' });
    await chat.send('loop forever');
    expect(bridge.transformCalls.length).toBe(MAX_TOOL_STEPS);
    expect(bridge.requests.length).toBe(MAX_TOOL_STEPS + 1);
    expect(bridge.requests.at(-1)!['tools']).toBeUndefined();
    expect(lastReply().content).toBe('Summary.');
  });

  it('reports tool errors back to the model instead of failing the turn', async () => {
    bridge.transformImpl = async () => {
      throw new BridgeError('transform_failed', 'crt.sh returned HTTP 502');
    };
    bridge.replies = [{ tool_calls: [call('domain_to_dns', { value: 'example.com' })] }, { content: 'The lookup failed.' }];
    await chat.send('try');
    const step = lastReply().meta!.steps.find((s) => s.kind === 'tool')!;
    expect(step.status).toBe('error');
    const toolMsg = (bridge.requests[1]['messages'] as { role: string; content: string }[]).at(-1)!;
    expect(toolMsg.content).toContain('crt.sh returned HTTP 502');
    expect(lastReply().meta!.status).toBe('done');
  });

  it('cancel stops a running lookup and marks the turn cancelled', async () => {
    let release!: () => void;
    bridge.transformImpl = () =>
      new Promise((_, reject) => {
        release = () => reject(new BridgeError('cancelled', 'cancelled'));
      });
    bridge.replies = [{ tool_calls: [call('domain_to_dns', { value: 'example.com' })] }];
    const pending = chat.send('slow');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(chat.busy()).toBe(true);
    chat.cancel();
    expect(bridge.cancelled.length).toBe(1);
    release();
    await pending;
    expect(chat.busy()).toBe(false);
    expect(lastReply().meta!.status).toBe('cancelled');
    expect(lastReply().meta!.steps.find((s) => s.kind === 'tool')!.status).toBe('cancelled');
  });

  it('on an empty graph: source_id may be a value, and a missing source never drops the finding', async () => {
    bridge.replies = [
      {
        tool_calls: [
          // What qwen3 actually did: values instead of ids, sometimes before the source existed.
          call('create_or_link_entity', { source_id: 'kiberzona.lv', edge_label: 'hosts', entity_type: 'Organization', value: 'Cloudflare, Inc.' }),
          call('create_or_link_entity', { source_id: 'kiberzona.lv', entity_type: 'Domain', value: 'kiberzona.lv' }),
          call('create_or_link_entity', { source_id: 'Kiberzona.lv.', edge_label: 'resolves_to', entity_type: 'IPv4', value: '104.21.76.3' }),
          call('append_entity_note', { entity_id: 'kiberzona.lv', note_markdown: 'Behind Cloudflare.' }),
        ],
      },
      { content: 'done' },
    ];
    await chat.send('add it');
    const steps = lastReply().meta!.steps.filter((s) => s.kind === 'tool');
    expect(steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(steps[0].summary).toContain('unlinked');
    expect(steps[1].summary).toBe('added Domain kiberzona.lv'); // self-reference: no "unlinked" warning
    expect(store.counts()).toEqual({ entities: 3, edges: 1 });
    const domain = [...store.entities().values()].find((e) => e.type === 'Domain')!;
    const edge = [...store.edges().values()][0];
    expect(edge).toMatchObject({ source_id: domain.id, label: 'resolves_to' });
    expect(domain.notes).toContain('Behind Cloudflare.');
    const firstResult = (bridge.requests[1]['messages'] as { role: string; content: string }[]).find((m) => m.role === 'tool')!;
    expect(firstResult.content).toContain('added without a link');
  });

  it('auto-apply: lookups add their results to the graph (creating the subject if needed) and return ids', async () => {
    bridge.replies = [{ tool_calls: [call('domain_to_dns', { value: 'example.com' })] }, { content: 'ok' }];
    await chat.send('look it up');
    expect(store.counts()).toEqual({ entities: 2, edges: 1 });
    const ip = [...store.entities().values()].find((e) => e.type === 'IPv4')!;
    const result = JSON.parse((bridge.requests[1]['messages'] as { role: string; content: string }[]).at(-1)!.content);
    expect(result.added_to_graph).toMatchObject({ new_entities: 1, links: 1 });
    expect(result.entities[0]).toMatchObject({ id: ip.id, type: 'IPv4', value: '192.0.2.1' });
    expect(lastReply().meta!.steps.find((s) => s.kind === 'tool')!.summary).toBe('1 result · 1 new on graph');
  });

  it('review mode: lookups stay read-only', async () => {
    settings.autoApply.set(false);
    bridge.replies = [{ tool_calls: [call('domain_to_dns', { value: 'example.com' })] }, { content: 'ok' }];
    await chat.send('look it up');
    expect(store.counts().entities).toBe(0);
    const result = JSON.parse((bridge.requests[1]['messages'] as { role: string; content: string }[]).at(-1)!.content);
    expect(result.added_to_graph).toBe(false);
  });

  it('failed tool pills carry the error in their expandable detail', async () => {
    bridge.transformImpl = async () => {
      throw new BridgeError('transform_failed', 'crt.sh is down');
    };
    bridge.replies = [{ tool_calls: [call('domain_to_dns', { value: 'example.com' })] }, { content: 'x' }];
    await chat.send('try');
    expect(lastReply().meta!.steps.find((s) => s.kind === 'tool')!.detail).toBe('Error: crt.sh is down');
  });

  it('lookups refuse to run when proxy mode has no URL (fail closed)', async () => {
    const network = TestBed.inject(NetworkSettings);
    network.mode.set('custom');
    network.customUrl.set('  ');
    await expect(TestBed.inject(TransformService).run('dns', { type: 'Domain', value: 'example.com' })).rejects.toThrow(/no proxy URL/);
    expect(bridge.transformCalls).toEqual([]);
  });

  it('a turn still running when another case opens leaves the new case alone', async () => {
    let answer: (() => void) | undefined;
    bridge.ollamaChat = (async () => {
      await new Promise<void>((r) => (answer = r));
      return { message: { role: 'assistant', content: 'late reply', tool_calls: undefined } };
    }) as unknown as FakeBridge['ollamaChat'];
    let autosaves = 0;
    chat.onTurnComplete = () => autosaves++;
    const turn = chat.send('slow question');
    for (let i = 0; i < 50 && !answer; i++) await new Promise((r) => setTimeout(r, 0)); // until the model is "thinking"
    expect(chat.busy()).toBe(true);

    // "Open case": the store and chat are replaced while the model is still answering.
    store.reset('Other case');
    chat.load([]);
    answer!();
    await turn;

    expect(chat.busy()).toBe(false);
    expect(chat.messages()).toEqual([]);
    expect(store.dirty()).toBe(false);
    expect(autosaves).toBe(0);
  });

  it('transform warnings appear once, whether streamed on stderr or only in messages', async () => {
    const transforms = TestBed.inject(TransformService);
    bridge.transformImpl = async () => {
      bridge.logHandler!({ job_id: bridge.lastJob, transform_id: 'dns', line: '[warn] AAAA: timed out' });
      return {
        contract_version: 1,
        entities: [],
        messages: [
          { level: 'warn', text: 'AAAA: timed out' },
          { level: 'warn', text: 'only in the JSON' },
        ],
      } as TransformResponse;
    };
    await transforms.run('dns', { type: 'Domain', value: 'example.com' });
    const texts = TestBed.inject(ConsoleLog).lines().map((l) => l.text);
    expect(texts.filter((t) => t === 'AAAA: timed out').length).toBe(1);
    expect(texts.filter((t) => t === 'only in the JSON').length).toBe(1);
  });

  it('labels entity references given as ids, values or proposals', () => {
    const d = store.upsertEntity({ type: 'Domain', value: 'acme.example' }).entity;
    expect(chat.labelOf(d.id)).toBe('acme.example');
    expect(chat.labelOf('ACME.example')).toBe('acme.example');
    expect(chat.labelOf('not-on-graph.example')).toBe('not-on-graph.example');
    expect(chat.labelOf('6f1c1f5e-2a4b-4c3d-9e8f-0a1b2c3d4e5f')).toBe('unknown entity');
  });

  it('refuses to send without a model', async () => {
    settings.model.set('');
    await chat.send('hello');
    expect(chat.messages()).toEqual([]);
  });

  it('system prompt summarizes the graph and flags review mode', () => {
    const a = store.upsertEntity({ type: 'Person', value: 'Alice' }).entity;
    const b = store.upsertEntity({ type: 'Organization', value: 'ACME' }).entity;
    store.upsertEdge(a.id, b.id, 'works_at');
    store.updateEntity(a.id, { notes: 'Met at conference.' });
    const prompt = buildSystemPrompt(
      { entities: store.entities(), edges: store.edges(), selectedIds: [a.id] },
      { autoApply: false, transforms: [DNS] },
    );
    expect(prompt).toContain('2 entities (Person: 1, Organization: 1), 1 links.');
    expect(prompt).toContain('Alice —works_at→ ACME');
    expect(prompt).toContain('notes: Met at conference.');
    expect(prompt).toContain('REVIEW MODE');
    expect(prompt).not.toContain('The graph is EMPTY');
    expect(buildSystemPrompt({ entities: new Map(), edges: new Map(), selectedIds: [] }, { autoApply: true, transforms: [] })).toContain('The graph is EMPTY');
    expect(prompt).toContain('Organization→Person: employs; Person→Organization: works_at; Person→Social_Account: has_account; Organization→Domain: owns');
  });

  describe('free-text searches', () => {
    beforeEach(() => {
      bridge.manifest = [DNS, WEB];
      bridge.transformImpl = async () => ({
        contract_version: 1,
        entities: [{ ref: 'e1', type: 'URL', value: 'https://news.example/a', properties: {} }],
        edges: [{ source: '$input', target: 'e1', label: 'mentioned_in' }],
        messages: [],
      });
    });

    it('runs a sentence that mentions a graph entity on that entity, with the sentence as the query', async () => {
      const domain = store.upsertEntity({ type: 'Domain', value: 'kiberzona.lv' }, { x: 0, y: 0 }).entity;
      bridge.replies = [{ tool_calls: [call('web_search', { entity_type: 'Domain', value: 'kiberzona.lv founders' })] }, { content: 'ok' }];

      await chat.send('Find the founders');

      expect(lastReply().meta?.steps.find((s) => s.kind === 'tool')?.status).toBe('done');
      expect(bridge.transformCalls).toEqual([{ id: 'web_search', value: 'kiberzona.lv', type: 'Domain' }]);
      expect(bridge.transformParams[0]).toEqual({ query: 'kiberzona.lv founders' });
      expect([...store.entities().values()].filter((e) => e.type === 'Domain').map((e) => e.value)).toEqual(['kiberzona.lv']);
      const url = [...store.entities().values()].find((e) => e.type === 'URL')!;
      expect([...store.edges().values()].some((e) => e.source_id === domain.id && e.target_id === url.id)).toBe(true);
    });

    it('gives a query about nothing on the graph its own search branch instead of failing', async () => {
      bridge.replies = [{ tool_calls: [call('web_search', { entity_type: 'Domain', value: 'who founded kiberzona' })] }, { content: 'ok' }];

      await chat.send('Who founded it?');

      expect(lastReply().meta?.steps.find((s) => s.kind === 'tool')?.status).toBe('done');
      expect(bridge.transformCalls[0]).toEqual({ id: 'web_search', value: 'Search · who founded kiberzona', type: 'Collection' });
      const branch = [...store.entities().values()].find((e) => e.type === 'Collection')!;
      expect(branch.properties['query']).toBe('who founded kiberzona');
    });

    it('still adds a plain valid value, such as a name, as that entity', async () => {
      bridge.replies = [{ tool_calls: [call('web_search', { entity_type: 'Person', value: 'Jane Doe' })] }, { content: 'ok' }];
      await chat.send('Search her');
      expect(bridge.transformCalls[0]).toEqual({ id: 'web_search', value: 'Jane Doe', type: 'Person' });
      expect(bridge.transformParams[0]).toBeUndefined();
    });

    it('does not match an entity value inside a longer word', async () => {
      store.upsertEntity({ type: 'Alias', value: 'kris' }, { x: 0, y: 0 });
      bridge.replies = [{ tool_calls: [call('web_search', { value: 'kristaps security research' })] }, { content: 'ok' }];
      await chat.send('Search');
      expect(bridge.transformCalls[0].value).not.toBe('kris');
    });
  });

  describe('thorough mode', () => {
    const WHOIS: TransformManifestEntry = { ...DNS, id: 'domain_to_whois', name: 'WHOIS' };
    const NEWS: TransformManifestEntry = { ...WEB, id: 'news_search', name: 'News' };

    beforeEach(() => {
      bridge.manifest = [DNS, WHOIS, WEB, NEWS];
      bridge.transformImpl = async () => ({ contract_version: 1, entities: [], edges: [], messages: [] });
      store.upsertEntity({ type: 'Domain', value: 'kiberzona.lv' }, { x: 0, y: 0 });
    });

    const toolCalls = () => bridge.transformCalls.map((c) => c.id);

    it('sends the model back when it stops after one lookup, listing what is unchecked', async () => {
      bridge.replies = [
        { tool_calls: [call('web_search', { value: 'kiberzona.lv' })] },
        { content: 'Found a few links.' }, // tries to stop here
        { tool_calls: [call('domain_to_whois', { value: 'kiberzona.lv' }), call('news_search', { value: 'kiberzona' })] },
        { content: 'Summary after the first nudge.' }, // DNS and targeted searches still unchecked: one more nudge
        { content: 'Full summary.' },
      ];

      await chat.send('Find everything related to kiberzona.lv, people and news');

      const nudge = bridge.requests[2]['messages'] as { role: string; content: string }[];
      const last = nudge.at(-1)!;
      expect(last.role).toBe('user');
      expect(last.content).toContain('domain_to_whois value="kiberzona.lv"');
      expect(last.content).toContain('domain_to_dns value="kiberzona.lv"');
      expect(last.content).toContain('news_search value="kiberzona"');
      expect(last.content).toContain('web_search value="kiberzona founder"');
      expect(last.content).not.toContain('web_search value="kiberzona.lv"'); // already run
      expect(toolCalls()).toEqual(['web_search', 'domain_to_whois', 'news_search']);
      expect(lastReply().meta?.steps.filter((s) => s.name === 'Coverage check').length).toBe(MAX_COVERAGE_NUDGES);
      expect(lastReply().content).toBe('Full summary.');
    });

    it('gives up after a bounded number of nudges', async () => {
      bridge.replies = Array.from({ length: 10 }, (_, i) => ({ content: `answer ${i}` }));
      await chat.send('Find everything about kiberzona.lv');
      expect(bridge.requests.length).toBe(MAX_COVERAGE_NUDGES + 1);
      expect(lastReply().content).toBe(`answer ${MAX_COVERAGE_NUDGES}`);
    });

    it('also follows leads the AI added, such as a username', async () => {
      bridge.manifest = [{ ...DNS, id: 'username_to_accounts', name: 'Usernames', input_types: ['Alias', 'Social_Account'] }];
      bridge.replies = [
        { tool_calls: [call('create_or_link_entity', { source_id: 'kiberzona.lv', entity_type: 'Social_Account', value: 'x.com/cyberkristaps', edge_label: 'has_account' })] },
        { content: 'Added the X account.' },
        { content: 'Done.' },
      ];
      await chat.send('Who runs kiberzona.lv?');
      const nudge = (bridge.requests[2]['messages'] as { content: string }[]).at(-1)!.content;
      expect(nudge).toContain('username_to_accounts value="cyberkristaps"');
    });

    it('does not nudge in quick mode', async () => {
      settings.depth.set('quick');
      bridge.replies = [{ content: 'Short answer.' }];
      await chat.send('Find everything about kiberzona.lv');
      expect(bridge.requests.length).toBe(1);
    });

    it('allows more steps than quick mode', () => {
      expect(MAX_TOOL_STEPS_THOROUGH).toBeGreaterThan(MAX_TOOL_STEPS);
    });
  });
});
