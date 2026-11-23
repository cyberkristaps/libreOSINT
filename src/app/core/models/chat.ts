// AI investigator chat. Persisted in the `.case` file (`chat_messages` table); `meta` is opaque to Rust.
import { EntityType, JsonValue } from './entity';

export type ChatRole = 'user' | 'assistant';
export type StepStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface ChatStep {
  id: string;
  kind: 'thinking' | 'tool';
  /** Tool name, or a label like "Thinking". */
  name: string;
  status: StepStatus;
  /** Short human summary (e.g. "7 entities"), shown on the pill. */
  summary?: string;
  /** Arguments the model passed (tools) — shown when the pill is expanded. */
  args?: Record<string, JsonValue>;
  /** Longer detail: model reasoning, or the tool result sent back to the model (truncated). */
  detail?: string;
}

export interface CreateOrLinkArgs {
  source_id?: string;
  edge_label?: string;
  entity_type: EntityType;
  value: string;
  properties?: Record<string, JsonValue>;
  initial_note?: string;
}

export interface AppendNoteArgs {
  entity_id: string;
  note_markdown: string;
}

export type ProposalStatus = 'pending' | 'applied' | 'dismissed' | 'error';

export type Proposal =
  | {
      id: string;
      kind: 'entity';
      status: ProposalStatus;
      args: CreateOrLinkArgs;
      /** Real entity id once applied. */
      applied_entity_id?: string;
      error?: string;
    }
  | { id: string; kind: 'note'; status: ProposalStatus; args: AppendNoteArgs; error?: string };

export interface ChatMeta {
  status: 'running' | 'done' | 'cancelled' | 'error';
  model?: string;
  steps: ChatStep[];
  proposals: Proposal[];
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  created_at: string;
  meta: ChatMeta | null;
}

/** Placeholder ids the model can use to chain proposals in review mode. */
export const PROPOSAL_ID_PREFIX = 'proposal-';
