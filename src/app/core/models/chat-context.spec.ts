import { coverageGaps, domainName, mentionedEntities, ranKey } from './chat-context';
import { Entity, EntityType } from './entity';
import { TransformManifestEntry } from './transform';

const ent = (type: EntityType, value: string, id = value): Entity => ({ id, type, value, properties: {}, notes: '', tags: [], created_at: '' });
const tf = (id: string, input_types: EntityType[]): TransformManifestEntry => ({
  id,
  name: id,
  description: '',
  command: [],
  input_types,
  output_types: [],
  timeout_s: 30,
  rate_limit: { max_concurrent: 1, min_interval_ms: 0 },
  requires_keys: [],
});
const ALL: EntityType[] = ['Domain', 'Subdomain', 'IPv4', 'IPv6', 'Email', 'Phone_Number', 'Person', 'Alias', 'Organization', 'Social_Account', 'Location', 'URL', 'SSL_Cert', 'Port_Service', 'Collection'];
const TRANSFORMS = [tf('domain_to_dns', ['Domain']), tf('domain_to_whois', ['Domain']), tf('web_search', ALL), tf('news_search', ALL), tf('username_to_accounts', ['Alias', 'Social_Account'])];

describe('domainName', () => {
  it('drops the TLD', () => {
    expect(domainName('kiberzona.lv')).toBe('kiberzona');
    expect(domainName('Shop.Example.com.')).toBe('shop.example');
    expect(domainName('localhost')).toBe('localhost');
  });
});

describe('mentionedEntities', () => {
  const graph = [ent('Domain', 'kiberzona.lv'), ent('Alias', 'kris'), ent('Person', 'Jane Doe'), ent('Collection', 'News · kiberzona.lv')];

  it('finds entities named in free text, including a domain by its bare name', () => {
    expect(mentionedEntities('Find everything about kiberzona.lv', graph).map((e) => e.value)).toEqual(['kiberzona.lv']);
    expect(mentionedEntities('kiberzona founders', graph).map((e) => e.value)).toEqual(['kiberzona.lv']);
    expect(mentionedEntities('Is jane doe involved?', graph).map((e) => e.value)).toEqual(['Jane Doe']);
  });

  it('matches whole words only and never branches', () => {
    expect(mentionedEntities('kristaps research', graph)).toEqual([]);
    expect(mentionedEntities('News · kiberzona.lv', graph).every((e) => e.type !== 'Collection')).toBe(true);
  });
});

describe('coverageGaps', () => {
  const domain = ent('Domain', 'kiberzona.lv', 'd1');

  it('lists the lookups and targeted searches a thorough investigation still needs', () => {
    const gaps = coverageGaps({ subjects: [domain], leads: [], transforms: TRANSFORMS, ran: new Set(), edges: new Map() });
    expect(gaps).toContain('domain_to_dns value="kiberzona.lv"');
    expect(gaps).toContain('domain_to_whois value="kiberzona.lv"');
    expect(gaps).toContain('news_search value="kiberzona"');
    expect(gaps).toContain('web_search value="kiberzona founder"');
    expect(gaps.length).toBeLessThanOrEqual(8);
  });

  it('skips what already ran, this turn or earlier (seen as links from that lookup)', () => {
    const ran = new Set([ranKey('domain_to_whois', 'd1'), ranKey('web_search', 'kiberzona founder')]);
    const edges = new Map([['x', { id: 'x', source_id: 'd1', target_id: 'ip', label: 'resolves_to', transform_source: 'domain_to_dns', timestamp: '' }]]);
    const gaps = coverageGaps({ subjects: [domain], leads: [], transforms: TRANSFORMS, ran, edges });
    expect(gaps.some((g) => g.startsWith('domain_to_whois'))).toBe(false);
    expect(gaps.some((g) => g.startsWith('domain_to_dns'))).toBe(false);
    expect(gaps).not.toContain('web_search value="kiberzona founder"');
  });

  it('follows leads: usernames get an account search, people a web search', () => {
    const gaps = coverageGaps({
      subjects: [],
      leads: [ent('Social_Account', 'x.com/cyberkristaps'), ent('Person', 'Jane Doe'), ent('URL', 'https://a.example/')],
      transforms: TRANSFORMS,
      ran: new Set(),
      edges: new Map(),
    });
    expect(gaps).toEqual(['username_to_accounts value="cyberkristaps"', 'web_search value="\\"Jane Doe\\""']);
  });

  it('only suggests lookups that exist', () => {
    expect(coverageGaps({ subjects: [domain], leads: [], transforms: [], ran: new Set(), edges: new Map() })).toEqual([]);
  });
});
