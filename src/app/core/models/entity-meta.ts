import { EntityType } from './entity';

export interface EntityTypeMeta {
  label: string;
  /** Short glyph shown in the palette and on nodes until real icons land in Phase 2. */
  glyph: string;
  color: string;
  placeholder: string;
}

export const ENTITY_META: Record<EntityType, EntityTypeMeta> = {
  Domain: { label: 'Domain', glyph: 'D', color: '#2563eb', placeholder: 'example.com' },
  Subdomain: { label: 'Subdomain', glyph: 'SD', color: '#0891b2', placeholder: 'www.example.com' },
  IPv4: { label: 'IPv4', glyph: '4', color: '#16a34a', placeholder: '192.0.2.1' },
  IPv6: { label: 'IPv6', glyph: '6', color: '#15803d', placeholder: '2001:db8::1' },
  Email: { label: 'Email', glyph: '@', color: '#db2777', placeholder: 'user@example.com' },
  Phone_Number: { label: 'Phone Number', glyph: 'PH', color: '#be123c', placeholder: '+371 2000 0000' },
  Person: { label: 'Person', glyph: 'P', color: '#9333ea', placeholder: 'Jane Doe' },
  Alias: { label: 'Alias', glyph: 'AL', color: '#c026d3', placeholder: 'jdoe92 (username or nickname)' },
  Organization: { label: 'Organization', glyph: 'O', color: '#7c3aed', placeholder: 'Example Inc.' },
  Social_Account: { label: 'Social Account', glyph: 'SN', color: '#0ea5e9', placeholder: 'x.com/handle or @user@mastodon.social' },
  Location: { label: 'Location', glyph: 'L', color: '#9a3412', placeholder: 'Riga, Latvia  or  56.9496, 24.1052' },
  URL: { label: 'URL', glyph: 'U', color: '#0d9488', placeholder: 'https://example.com/' },
  SSL_Cert: { label: 'SSL Cert', glyph: 'C', color: '#ea580c', placeholder: 'SHA-256 fingerprint' },
  Port_Service: { label: 'Port / Service', glyph: ':', color: '#dc2626', placeholder: '443/tcp https' },
};
