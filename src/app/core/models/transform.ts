// TS mirror of the transform JSON contract (v1). See CLAUDE.md and schema/transform-*.schema.json.
import { EntityType, JsonValue } from './entity';

export const TRANSFORM_CONTRACT_VERSION = 1;
export const INPUT_REF = '$input';

export interface TransformManifestEntry {
  id: string;
  name: string;
  description: string;
  command: string[];
  input_types: EntityType[];
  output_types: EntityType[];
  timeout_s: number;
  rate_limit: { max_concurrent: number; min_interval_ms: number };
  requires_keys: string[];
}

export interface TransformManifest {
  contract_version: number;
  transforms: TransformManifestEntry[];
}

export interface TransformRequest {
  contract_version: number;
  transform_id: string;
  entity: { id: string; type: EntityType; value: string; properties: Record<string, JsonValue> };
  params: Record<string, JsonValue>;
}

export interface TransformOutputEntity {
  ref: string;
  type: EntityType;
  value: string;
  properties?: Record<string, JsonValue>;
  tags?: string[];
}

export interface TransformOutputEdge {
  source: string;
  target: string;
  label: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TransformResponse {
  contract_version: number;
  entities: TransformOutputEntity[];
  edges?: TransformOutputEdge[];
  messages?: { level: LogLevel; text: string }[];
  /** Free-form results for the AI investigator (page text, search results…); not ingested. */
  data?: Record<string, JsonValue>;
}
