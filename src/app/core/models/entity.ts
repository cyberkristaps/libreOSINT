// TS mirror of schema/entity.schema.json and schema/edge.schema.json.
// Keep in sync with src-tauri/src/model.rs.

export const ENTITY_TYPES = [
  'Domain',
  'Subdomain',
  'IPv4',
  'IPv6',
  'Email',
  'Phone_Number',
  'Person',
  'Alias',
  'Organization',
  'Social_Account',
  'Location',
  'URL',
  'SSL_Cert',
  'Port_Service',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface Entity {
  id: string;
  type: EntityType;
  value: string;
  properties: Record<string, JsonValue>;
  notes: string;
  tags: string[];
  /** RFC 3339 UTC timestamp. */
  created_at: string;
}

export interface Edge {
  id: string;
  source_id: string;
  target_id: string;
  /** snake_case relationship, e.g. `resolves_to`. */
  label: string;
  /** Transform id that produced the edge, or `manual`. */
  transform_source: string;
  /** RFC 3339 UTC timestamp. */
  timestamp: string;
}

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}
