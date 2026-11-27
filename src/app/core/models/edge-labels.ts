import { EntityType } from './entity';

export const DEFAULT_EDGE_LABEL = 'related_to';

/** Matches `label` in schema/edge.schema.json. */
export const EDGE_LABEL_PATTERN = /^[a-z][a-z0-9_]*$/;

type Rule = [from: EntityType[] | '*', to: EntityType[] | '*', labels: string[]];

const HOSTS: EntityType[] = ['Domain', 'Subdomain'];
const IPS: EntityType[] = ['IPv4', 'IPv6'];
const PARTIES: EntityType[] = ['Person', 'Organization'];

// First matching rules win; suggestions are merged in order and `related_to` is always offered last.
const RULES: Rule[] = [
  [['Person'], ['Organization'], ['works_at', 'member_of', 'owns', 'founded']],
  [['Organization'], ['Person'], ['employs', 'has_member', 'owned_by', 'founded_by']],
  [['Person'], ['Person'], ['knows', 'family_of', 'alias_of']],
  [['Organization'], ['Organization'], ['subsidiary_of', 'parent_of', 'partner_of']],
  [PARTIES, HOSTS, ['owns', 'registered', 'operates']],
  [HOSTS, PARTIES, ['registered_to', 'owned_by', 'operated_by']],
  [['Person'], ['Social_Account'], ['has_account', 'uses_account']],
  [['Organization'], ['Social_Account'], ['has_account', 'operates']],
  [['Social_Account'], ['Person'], ['belongs_to', 'operated_by']],
  [['Social_Account'], ['Organization'], ['belongs_to', 'operated_by']],
  [['Social_Account'], ['Social_Account'], ['follows', 'mentions', 'alias_of']],
  [['Email'], ['Social_Account'], ['registered_account']],
  [['Social_Account'], ['Email'], ['registered_with', 'lists_email']],
  [['Social_Account'], ['URL', 'Domain'], ['links_to']],
  [['URL'], ['Social_Account'], ['mentions', 'links_to']],
  // phones & aliases
  [PARTIES, ['Phone_Number'], ['has_phone']],
  [['Phone_Number'], PARTIES, ['belongs_to']],
  [[...HOSTS, 'Social_Account'], ['Phone_Number'], ['lists_phone']],
  [['Person'], ['Alias'], ['known_as', 'uses_alias']],
  [['Alias'], ['Person'], ['alias_of']],
  [['Alias'], ['Social_Account'], ['used_on']],
  [['Social_Account'], ['Alias'], ['has_username']],
  [['Alias'], ['Email'], ['used_in']],
  // locations
  [PARTIES, ['Location'], ['located_in', 'based_in', 'lives_in']],
  [['Location'], PARTIES, ['location_of']],
  [IPS, ['Location'], ['geolocated_in']],
  [['Location'], ['Location'], ['part_of', 'near']],
  [['Social_Account', 'URL', 'Phone_Number'], ['Location'], ['mentions_location', 'located_in']],
  [PARTIES, ['Email'], ['uses_email']],
  [['Email'], PARTIES, ['belongs_to']],
  [['Domain'], ['Subdomain'], ['has_subdomain']],
  [['Subdomain'], ['Domain'], ['subdomain_of']],
  [HOSTS, IPS, ['resolves_to']],
  [IPS, HOSTS, ['reverse_resolves_to', 'hosts']],
  [IPS, ['Organization'], ['registered_to', 'hosted_by']],
  [['Organization'], IPS, ['owns', 'operates']],
  [HOSTS, ['Email'], ['has_email', 'mx_for']],
  [['Email'], HOSTS, ['on_domain']],
  [[...IPS, ...HOSTS], ['Port_Service'], ['exposes_port']],
  [['SSL_Cert'], HOSTS, ['issued_to']],
  [HOSTS, ['SSL_Cert'], ['presents_cert']],
  [['URL'], HOSTS, ['hosted_on']],
  [HOSTS, ['URL'], ['serves']],
  // collections (branches that group results)
  ['*', ['Collection'], ['has_results']],
  [['Collection'], '*', ['contains']],
  ['*', '*', ['associated_with', 'mentions']],
];

const matches = (set: EntityType[] | '*', t: EntityType) => set === '*' || set.includes(t);

/** Relationship labels that make sense from `source` to `target`, most specific first. */
export function suggestEdgeLabels(source: EntityType, target: EntityType): string[] {
  const out: string[] = [];
  for (const [from, to, labels] of RULES) {
    if (matches(from, source) && matches(to, target)) out.push(...labels);
  }
  return [...new Set(out.filter((l) => l !== DEFAULT_EDGE_LABEL)), DEFAULT_EDGE_LABEL];
}

/** Turn free text like "Works at" into a valid snake_case label, or null if nothing usable remains. */
export function toEdgeLabel(text: string): string | null {
  const label = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[_0-9]+|_+$/g, '');
  return EDGE_LABEL_PATTERN.test(label) ? label : null;
}
