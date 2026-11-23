import { Injectable, computed, inject, signal } from '@angular/core';
import { AppendNoteArgs, ChatMessage, ChatMeta, ChatStep, CreateOrLinkArgs, Proposal, PROPOSAL_ID_PREFIX } from '../models/chat';
import { CREATE_TOOL, MAX_TOOL_STEPS, NOTE_TOOL, buildSystemPrompt, buildTools } from '../models/chat-context';
import { ENTITY_TYPES, EntityType, JsonValue, isEntityType } from '../models/entity';
import { TransformResponse } from '../models/transform';
import { ChatSettings } from './chat-settings';
import { ConsoleLog } from './console-log';
import { GraphStore } from './graph-store';
import { AI_TAG, GraphTools, IngestResult } from './graph-tools';
import { BridgeError, TauriBridge } from './tauri-bridge';
import { TransformService, newJobId } from './transform-service';

interface OllamaToolCall {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> | string };
}
interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
  tool_call_id?: string;
}
interface OllamaChatResponse {
  message?: OllamaMessage;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_MESSAGES = 20;
const MAX_TOOL_RESULT_CHARS = 12000;

class CancelledError extends Error {}

/**
 * AI Investigator: multi-turn Ollama tool calling over the transform registry and the graph.
 * Conversation state lives here and is saved in the `.case` file by CaseFile.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly bridge = inject(TauriBridge);
  private readonly settings = inject(ChatSettings);
  private readonly store = inject(GraphStore);
  private readonly tools = inject(GraphTools);
  private readonly transforms = inject(TransformService);
  private readonly log = inject(ConsoleLog);

  readonly messages = signal<ChatMessage[]>([]);
  readonly busy = signal(false);
  /** Text waiting in the input box (e.g. pre-filled by "Ask AI about this"). */
  readonly draft = signal('');
  readonly pendingProposals = computed(() =>
    this.messages().reduce((n, m) => n + (m.meta?.proposals.filter((p) => p.status === 'pending').length ?? 0), 0),
  );
  /** Fired after an assistant turn finishes (used for autosave). */
  onTurnComplete?: () => void;

  private cancelled = false;
  /** Bumped when the conversation is replaced (case opened/new, chat cleared): older turns must not touch it. */
  private generation = 0;
  private readonly activeJobs = new Set<string>();
  /** Proposals being applied right now (dependencies included), to stop on cycles. */
  private readonly applying = new Set<string>();

  load(messages: ChatMessage[] | undefined): void {
    this.cancel();
    this.generation++;
    this.messages.set((messages ?? []).map((m) => (m.meta?.status === 'running' ? { ...m, meta: { ...m.meta, status: 'cancelled' } } : m)));
  }

  clear(): void {
    this.cancel();
    this.generation++;
    this.messages.set([]);
    this.store.dirty.set(true);
  }

  cancel(): void {
    if (!this.busy()) return;
    this.cancelled = true;
    for (const job of this.activeJobs) void this.bridge.cancelJob(job);
  }

  async send(text: string): Promise<void> {
    const prompt = text.trim();
    const model = this.settings.model();
    if (!prompt || this.busy()) return;
    if (!model) {
      this.log.log('warn', 'ai', 'Pick an Ollama model in the AI Chat settings first');
      return;
    }

    const history = this.messages()
      .filter((m) => m.content.trim())
      .slice(-HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }) as OllamaMessage);
    const user = this.newMessage('user', prompt, null);
    const reply = this.newMessage('assistant', '', { status: 'running', model, steps: [], proposals: [] });
    this.messages.update((ms) => [...ms, user, reply]);
    this.store.dirty.set(true);
    this.busy.set(true);
    this.cancelled = false;
    const generation = this.generation;
    const current = () => generation === this.generation;
    // Everything this turn changes on the graph is one undo step.
    this.store.beginGroup(`AI: ${prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt}`);

    try {
      await this.transforms.ensureLoaded();
      const manifest = this.transforms.transforms();
      const tools = buildTools(manifest, { autoApply: this.settings.autoApply() });
      const system = buildSystemPrompt(
        { entities: this.store.entities(), edges: this.store.edges(), selectedIds: this.store.selectedIds() },
        { autoApply: this.settings.autoApply(), transforms: manifest },
      );
      const convo: OllamaMessage[] = [{ role: 'system', content: system }, ...history, { role: 'user', content: prompt }];

      let final: string | null = null;
      for (let step = 0; step <= MAX_TOOL_STEPS && final === null; step++) {
        const lastRound = step === MAX_TOOL_STEPS;
        if (lastRound) {
          convo.push({ role: 'user', content: 'Tool step limit reached. Summarize what you found so far without calling tools.' });
        }
        const thinking = this.addStep(reply.id, {
          kind: 'thinking',
          name: step === 0 ? 'Thinking' : lastRound ? 'Summarizing' : `Thinking · step ${step + 1}`,
          status: 'running',
        });
        const res = await this.callOllama({
          model,
          messages: convo,
          ...(lastRound ? {} : { tools }),
          options: { temperature: 0 },
        });
        const msg = res.message ?? { role: 'assistant', content: '' };
        const calls = lastRound ? [] : (msg.tool_calls ?? []);
        this.updateStep(reply.id, thinking, {
          status: 'done',
          detail: msg.thinking?.trim() || undefined,
          summary: calls.length ? `${calls.length} tool call${calls.length > 1 ? 's' : ''}` : 'answer ready',
        });
        convo.push({ role: 'assistant', content: msg.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) {
          final = msg.content ?? '';
          break;
        }
        for (const call of calls) {
          const result = await this.runTool(reply.id, call);
          convo.push({
            role: 'tool',
            tool_name: call.function.name,
            ...(call.id ? { tool_call_id: call.id } : {}),
            content: clipJson(result),
          });
        }
      }
      if (current()) this.finish(reply.id, { status: 'done' }, final?.trim() || '(The model returned no text.)');
    } catch (err) {
      if (!current()) {
        // The case was switched or the chat cleared mid-turn: this turn's conversation is gone.
      } else if (err instanceof CancelledError || (err as BridgeError).kind === 'cancelled') {
        this.finish(reply.id, { status: 'cancelled' }, this.contentOf(reply.id) || 'Cancelled.');
      } else {
        const message = (err as Error).message;
        this.log.log('error', 'ai', message);
        this.finish(reply.id, { status: 'error', error: message }, this.contentOf(reply.id));
      }
    } finally {
      const mine = current();
      if (mine) this.store.endGroup(); // a case load already reset the undo grouping
      this.busy.set(false);
      this.activeJobs.clear();
      if (mine) this.onTurnComplete?.(); // never autosave the newly opened case
    }
  }

  // --- review mode ------------------------------------------------------------------
  applyProposal(messageId: string, proposalId: string): void {
    this.store.group('Apply AI proposal', () => this.applyProposalInner(messageId, proposalId));
  }

  private applyProposalInner(messageId: string, proposalId: string): void {
    const msg = this.messages().find((m) => m.id === messageId);
    const p = msg?.meta?.proposals.find((x) => x.id === proposalId);
    if (!msg || !p || p.status === 'applied' || p.status === 'dismissed') return;
    // A model can name a proposal as its own source (ids are guessable), or two as each other's.
    if (this.applying.has(proposalId)) throw new Error(`circular dependency on ${proposalId}`);
    this.applying.add(proposalId);
    try {
      if (p.kind === 'entity') {
        const source_id = p.args.source_id ? this.resolveId(p.args.source_id, true) : undefined;
        const r = this.tools.createOrLink({ ...p.args, source_id });
        this.setProposal(messageId, proposalId, { status: 'applied', applied_entity_id: r.entity_id, error: undefined });
        this.store.select(r.entity_id);
      } else {
        this.tools.appendNote({ ...p.args, entity_id: this.resolveId(p.args.entity_id, true)! });
        this.setProposal(messageId, proposalId, { status: 'applied', error: undefined });
      }
    } catch (err) {
      this.setProposal(messageId, proposalId, { status: 'error', error: (err as Error).message });
    } finally {
      this.applying.delete(proposalId);
    }
  }

  applyAll(messageId: string): void {
    const msg = this.messages().find((m) => m.id === messageId);
    this.store.group('Apply all AI proposals', () => {
      for (const p of msg?.meta?.proposals ?? []) if (p.status === 'pending' || p.status === 'error') this.applyProposal(messageId, p.id);
    });
  }

  dismissProposal(messageId: string, proposalId: string): void {
    this.setProposal(messageId, proposalId, { status: 'dismissed' });
  }

  /** Map a proposal placeholder to its real entity id, applying the proposal first if needed. */
  private resolveId(id: string, applyDeps: boolean): string | undefined {
    if (!id.startsWith(PROPOSAL_ID_PREFIX)) return id;
    for (const m of this.messages()) {
      const p = m.meta?.proposals.find((x) => x.id === id);
      if (p?.kind !== 'entity') continue;
      if (p.status !== 'applied' && applyDeps) this.applyProposal(m.id, p.id);
      const again = this.messages().find((x) => x.id === m.id)?.meta?.proposals.find((x) => x.id === id);
      if (again?.kind === 'entity' && again.applied_entity_id) return again.applied_entity_id;
      throw new Error(`depends on ${id}, which could not be applied`);
    }
    throw new Error(`unknown proposal ${id}`);
  }

  // --- tools ------------------------------------------------------------------------
  private async runTool(messageId: string, call: OllamaToolCall): Promise<unknown> {
    const name = call.function?.name ?? '?';
    const args = parseArgs(call.function?.arguments);
    const stepId = this.addStep(messageId, { kind: 'tool', name, status: 'running', args: args as Record<string, JsonValue> });
    try {
      let result: unknown;
      let summary: string;
      if (name === CREATE_TOOL || name === NOTE_TOOL) {
        ({ result, summary } = this.graphTool(messageId, name, args));
      } else if (this.transforms.transforms().some((t) => t.id === name)) {
        ({ result, summary } = await this.lookupTool(name, args));
      } else {
        throw new Error(`unknown tool "${name}"`);
      }
      this.throwIfCancelled();
      this.updateStep(messageId, stepId, { status: 'done', summary, detail: clipJson(result, 4000) });
      return result;
    } catch (err) {
      if (err instanceof CancelledError || (err as BridgeError).kind === 'cancelled') {
        this.updateStep(messageId, stepId, { status: 'cancelled', summary: 'cancelled' });
        throw new CancelledError();
      }
      const message = (err as Error).message;
      this.updateStep(messageId, stepId, { status: 'error', summary: message, detail: `Error: ${message}` });
      return { error: message };
    }
  }

  private graphTool(messageId: string, name: string, args: Record<string, unknown>): { result: unknown; summary: string } {
    if (name === CREATE_TOOL) {
      const a = args as unknown as CreateOrLinkArgs;
      if (!isEntityType(String(a.entity_type))) throw new Error(`entity_type must be one of the entity types: ${ENTITY_TYPES.join(', ')}`);
      if (typeof a.value !== 'string' || !a.value.trim()) throw new Error('value is required');
      if (!this.settings.autoApply()) {
        const id = this.addProposal(messageId, { kind: 'entity', args: a });
        return {
          result: { status: 'proposed_for_review', proposal_id: id, note: 'Not on the graph yet; the user will review it. You may use proposal_id as source_id/entity_id.' },
          summary: `proposed ${a.entity_type} ${a.value}`,
        };
      }
      const source_id = a.source_id ? this.resolveId(a.source_id, false) : undefined;
      const r = this.tools.createOrLink({ ...a, source_id });
      return {
        result: { status: 'applied', ...r },
        summary: `${r.created ? 'added' : 'updated'} ${a.entity_type} ${a.value}${r.edge_label ? ` (${r.edge_label})` : r.warning ? ' (unlinked: source not found)' : ''}`,
      };
    }
    const a = args as unknown as AppendNoteArgs;
    if (!a.entity_id || !a.note_markdown?.trim()) throw new Error('entity_id and note_markdown are required');
    if (!this.settings.autoApply()) {
      const id = this.addProposal(messageId, { kind: 'note', args: a });
      return { result: { status: 'proposed_for_review', proposal_id: id }, summary: `proposed note on ${this.labelOf(a.entity_id)}` };
    }
    const r = this.tools.appendNote({ ...a, entity_id: this.resolveId(a.entity_id, false)! });
    return { result: { status: 'applied', ...r }, summary: `note added to ${this.labelOf(r.entity_id)}` };
  }

  private async lookupTool(name: string, args: Record<string, unknown>): Promise<{ result: unknown; summary: string }> {
    const entry = this.transforms.transforms().find((t) => t.id === name)!;
    const value = String(args['value'] ?? '').trim();
    if (!value) throw new Error('value is required');
    const type = this.pickType(value, args['entity_type'], entry.input_types);
    // Auto-apply: like a manual "Run lookup", results land on the graph, linked from the looked-up entity
    // (created first if the model is looking up something that isn't on the graph yet).
    const target = this.settings.autoApply()
      ? (this.tools.findEntity(value, type) ?? this.store.upsertEntity({ type, value, tags: [AI_TAG] }).entity)
      : undefined;
    const jobId = newJobId('ai');
    this.activeJobs.add(jobId);
    try {
      const res = await this.transforms.run(name, { type, value: target?.value ?? value, id: target?.id }, { jobId });
      this.throwIfCancelled();
      let added: IngestResult | undefined;
      if (target && this.store.entities().has(target.id)) added = this.tools.ingestTransform(target.id, name, res);
      const n = res.entities.length;
      const summary = `${n} result${n === 1 ? '' : 's'}${added ? ` · ${added.created} new on graph` : ''}`;
      return { result: summarizeTransform(res, added, target?.id), summary };
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /** Use the model's entity_type if valid, else the type of a matching graph entity, else the first input type. */
  private pickType(value: string, requested: unknown, allowed: EntityType[]): EntityType {
    if (typeof requested === 'string' && (allowed as string[]).includes(requested)) return requested as EntityType;
    const onGraph = [...this.store.entities().values()].find((e) => e.value === value && allowed.includes(e.type));
    return onGraph?.type ?? allowed[0];
  }

  private async callOllama(body: Record<string, unknown>): Promise<OllamaChatResponse> {
    this.throwIfCancelled();
    const jobId = newJobId('llm');
    this.activeJobs.add(jobId);
    try {
      const res = await this.bridge.ollamaChat<OllamaChatResponse>(jobId, this.settings.url(), body);
      this.throwIfCancelled();
      if (res.error) throw new Error(`Ollama: ${res.error}`);
      return res;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledError();
  }

  // --- message state ----------------------------------------------------------------
  private newMessage(role: 'user' | 'assistant', content: string, meta: ChatMeta | null): ChatMessage {
    return { id: crypto.randomUUID(), role, content, created_at: new Date().toISOString(), meta };
  }

  private patchMeta(id: string, fn: (meta: ChatMeta) => ChatMeta, content?: string): void {
    this.messages.update((ms) =>
      ms.map((m) => (m.id === id && m.meta ? { ...m, meta: fn(m.meta), ...(content !== undefined ? { content } : {}) } : m)),
    );
  }

  private addStep(messageId: string, step: Omit<ChatStep, 'id'>): string {
    const id = crypto.randomUUID();
    this.patchMeta(messageId, (meta) => ({ ...meta, steps: [...meta.steps, { id, ...step }] }));
    return id;
  }

  private updateStep(messageId: string, stepId: string, patch: Partial<ChatStep>): void {
    this.patchMeta(messageId, (meta) => ({ ...meta, steps: meta.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s)) }));
  }

  private addProposal(messageId: string, p: { kind: 'entity'; args: CreateOrLinkArgs } | { kind: 'note'; args: AppendNoteArgs }): string {
    const n = this.messages().reduce((acc, m) => acc + (m.meta?.proposals.length ?? 0), 0) + 1;
    const id = `${PROPOSAL_ID_PREFIX}${n}`;
    this.patchMeta(messageId, (meta) => ({ ...meta, proposals: [...meta.proposals, { id, status: 'pending', ...p } as Proposal] }));
    return id;
  }

  private setProposal(messageId: string, proposalId: string, patch: Partial<Proposal>): void {
    this.patchMeta(messageId, (meta) => ({
      ...meta,
      proposals: meta.proposals.map((p) => (p.id === proposalId ? ({ ...p, ...patch } as Proposal) : p)),
    }));
    this.store.dirty.set(true);
  }

  private finish(messageId: string, patch: Partial<ChatMeta>, content: string): void {
    this.patchMeta(
      messageId,
      (meta) => ({
        ...meta,
        ...patch,
        steps: meta.steps.map((s) => (s.status === 'running' ? { ...s, status: 'cancelled' as const } : s)),
      }),
      content,
    );
    this.store.dirty.set(true);
  }

  private contentOf(id: string): string {
    return this.messages().find((m) => m.id === id)?.content ?? '';
  }

  /** Label for an entity reference as the model gives it: an entity id, an entity value, or a proposal id. */
  labelOf(ref: string | undefined): string {
    if (!ref) return '';
    if (ref.startsWith(PROPOSAL_ID_PREFIX)) {
      for (const m of this.messages()) {
        const p = m.meta?.proposals.find((x) => x.id === ref);
        if (p?.kind === 'entity') return `${p.args.value} (proposed)`;
      }
      return ref;
    }
    const found = this.tools.findEntity(ref);
    if (found) return found.value;
    return UUID.test(ref) ? 'unknown entity' : ref;
  }

}

function parseArgs(raw: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw;
}

/** What the model sees from a lookup: entities (with graph ids when added), links, messages, extra data — size-capped. */
export function summarizeTransform(res: TransformResponse, added?: IngestResult, inputId?: string): unknown {
  const byRef = new Map(res.entities.map((e) => [e.ref, e.value]));
  return {
    ...(added
      ? { added_to_graph: { input_entity_id: inputId, new_entities: added.created, updated_entities: added.merged, links: added.edges } }
      : { added_to_graph: false }),
    entities: res.entities
      .slice(0, 60)
      .map((e) => ({ ...(added?.ids[e.ref] ? { id: added.ids[e.ref] } : {}), type: e.type, value: e.value, properties: e.properties ?? {} })),
    entity_count: res.entities.length,
    links: (res.edges ?? []).slice(0, 60).map((e) => `${byRef.get(e.source) ?? 'input'} —${e.label}→ ${byRef.get(e.target) ?? 'input'}`),
    messages: (res.messages ?? []).map((m) => `${m.level}: ${m.text}`),
    data: res.data ?? {},
  };
}

function clipJson(value: unknown, max = MAX_TOOL_RESULT_CHARS): string {
  const s = JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}
