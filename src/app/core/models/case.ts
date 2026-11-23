// Wire format exchanged with the Rust `case_open` / `case_save` commands (src-tauri/src/storage).
import { Edge, Entity } from './entity';
import { ChatMessage } from './chat';

export const CASE_FORMAT = 'libre-osint-case';
export const CASE_FORMAT_VERSION = 1;
/** Format tags written by earlier builds (the project was renamed from awesomeOSINT). */
export const LEGACY_CASE_FORMATS: readonly string[] = ['awesome-osint-case'];

export interface Position {
  x: number;
  y: number;
}

export interface CaseSnapshot {
  format: typeof CASE_FORMAT;
  version: number;
  name: string;
  entities: Entity[];
  edges: Edge[];
  /** Canvas positions keyed by entity id. */
  positions: Record<string, Position>;
  /** AI investigator conversation (absent in older snapshots). */
  chat?: ChatMessage[];
  /** Set by Rust on load: entities of types this version no longer supports were left out. */
  skipped_entities?: number;
}
