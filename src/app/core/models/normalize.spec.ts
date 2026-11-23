import vectors from '../../../../schema/dedup-vectors.json';
import { EntityType } from './entity';
import { InvalidValueError, entityKey, normalizeValue, socialAccountInfo } from './normalize';

describe('normalizeValue (shared vectors)', () => {
  for (const [type, input, expected] of vectors.normalize) {
    it(`${type} ${JSON.stringify(input)} -> ${expected}`, () => {
      expect(normalizeValue(type as EntityType, input)).toBe(expected);
    });
  }

  for (const [type, input] of vectors.invalid) {
    it(`rejects ${type} ${JSON.stringify(input)}`, () => {
      expect(() => normalizeValue(type as EntityType, input)).toThrow(InvalidValueError);
    });
  }
});

describe('entityKey', () => {
  it('is equal for spellings that normalize the same', () => {
    expect(entityKey('Domain', 'Example.com.')).toBe(entityKey('Domain', 'example.com'));
  });

  it('differs across types for the same value', () => {
    expect(entityKey('Domain', 'example.com')).not.toBe(entityKey('Subdomain', 'example.com'));
  });
});

describe('socialAccountInfo', () => {
  it('derives platform, handle and profile URL', () => {
    expect(socialAccountInfo('https://twitter.com/JDoe')).toEqual({ platform: 'X', handle: 'jdoe', profile_url: 'https://x.com/jdoe' });
    expect(socialAccountInfo('linkedin.com/in/Jane-Doe')).toEqual({ platform: 'LinkedIn', handle: 'jane-doe', profile_url: 'https://linkedin.com/in/jane-doe' });
    expect(socialAccountInfo('@alice@infosec.exchange')).toEqual({ platform: 'Fediverse (infosec.exchange)', handle: 'alice', profile_url: 'https://infosec.exchange/@alice' });
    expect(socialAccountInfo('tiktok.com/@Bob')!.platform).toBe('TikTok');
  });

  it('returns null for bare handles (platform unknown)', () => {
    expect(socialAccountInfo('@jdoe')).toBeNull();
  });
});
