import { EntityType } from './entity';

export interface EntityTypeMeta {
  label: string;
  color: string;
  placeholder: string;
  /** Short type code shown inside the node on the canvas and in the palette. */
  code: string;
}

export const ENTITY_META: Record<EntityType, EntityTypeMeta> = {
  Domain: { label: 'Domain', color: '#2563eb', placeholder: 'example.com', code: 'DOM' },
  Subdomain: { label: 'Subdomain', color: '#0891b2', placeholder: 'www.example.com', code: 'SUB' },
  IPv4: { label: 'IPv4', color: '#16a34a', placeholder: '192.0.2.1', code: 'IPv4' },
  IPv6: { label: 'IPv6', color: '#15803d', placeholder: '2001:db8::1', code: 'IPv6' },
  Email: { label: 'Email', color: '#db2777', placeholder: 'user@example.com', code: '@' },
  Phone_Number: { label: 'Phone Number', color: '#be123c', placeholder: '+371 2000 0000', code: 'TEL' },
  Person: { label: 'Person', color: '#9333ea', placeholder: 'Jane Doe', code: 'PER' },
  Alias: { label: 'Alias', color: '#c026d3', placeholder: 'jdoe92 (username or nickname)', code: 'AKA' },
  Organization: { label: 'Organization', color: '#7c3aed', placeholder: 'Example Inc.', code: 'ORG' },
  Social_Account: { label: 'Social Account', color: '#0ea5e9', placeholder: 'x.com/handle or @user@mastodon.social', code: 'SOC' },
  Location: { label: 'Location', color: '#9a3412', placeholder: 'Riga, Latvia  or  56.9496, 24.1052', code: 'LOC' },
  URL: { label: 'URL', color: '#0d9488', placeholder: 'https://example.com/', code: 'URL' },
  SSL_Cert: { label: 'SSL Cert', color: '#ea580c', placeholder: 'SHA-256 fingerprint', code: 'CERT' },
  Port_Service: { label: 'Port / Service', color: '#dc2626', placeholder: '443/tcp https', code: 'PORT' },
  Collection: { label: 'Collection', color: '#64748b', placeholder: 'News · example.com', code: '≡' },
};
