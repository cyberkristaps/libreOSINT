import { DEFAULT_EDGE_LABEL, suggestEdgeLabels, toEdgeLabel } from './edge-labels';

describe('suggestEdgeLabels', () => {
  it('offers employment relations between people and organizations, in both directions', () => {
    expect(suggestEdgeLabels('Person', 'Organization')[0]).toBe('works_at');
    expect(suggestEdgeLabels('Organization', 'Person')[0]).toBe('employs');
  });

  it('offers account relations for people and organizations', () => {
    expect(suggestEdgeLabels('Person', 'Social_Account')[0]).toBe('has_account');
    expect(suggestEdgeLabels('Social_Account', 'Person')[0]).toBe('belongs_to');
    expect(suggestEdgeLabels('Organization', 'Social_Account')[0]).toBe('has_account');
  });

  it('offers relations for phones, aliases, locations and IP owners', () => {
    expect(suggestEdgeLabels('Person', 'Phone_Number')[0]).toBe('has_phone');
    expect(suggestEdgeLabels('Person', 'Alias')[0]).toBe('known_as');
    expect(suggestEdgeLabels('Alias', 'Social_Account')[0]).toBe('used_on');
    expect(suggestEdgeLabels('Organization', 'Location')[0]).toBe('located_in');
    expect(suggestEdgeLabels('IPv4', 'Organization')[0]).toBe('registered_to');
  });

  it('offers infrastructure relations', () => {
    expect(suggestEdgeLabels('Domain', 'IPv4')).toContain('resolves_to');
    expect(suggestEdgeLabels('Domain', 'Subdomain')[0]).toBe('has_subdomain');
    expect(suggestEdgeLabels('SSL_Cert', 'Subdomain')[0]).toBe('issued_to');
  });

  it('always ends with the default label and never repeats', () => {
    for (const labels of [suggestEdgeLabels('Port_Service', 'Person'), suggestEdgeLabels('Person', 'Person')]) {
      expect(labels.at(-1)).toBe(DEFAULT_EDGE_LABEL);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe('toEdgeLabel', () => {
  it('normalizes free text into snake_case', () => {
    expect(toEdgeLabel('  Works at ')).toBe('works_at');
    expect(toEdgeLabel('CEO-of')).toBe('ceo_of');
    expect(toEdgeLabel('2nd owner')).toBe('nd_owner');
  });

  it('rejects text with no usable characters', () => {
    expect(toEdgeLabel('  ')).toBeNull();
    expect(toEdgeLabel('!!!')).toBeNull();
  });
});
