import { describe, expect, it } from 'vitest';
import { normalizeWorkKeyPrefix, parseWorkKeys } from './work-keys.js';

describe('work keys (54-10)', () => {
  it('parses the key corpus and ignores unknown prefixes', () => {
    const keys = (text: string) =>
      parseWorkKeys(text, ['TM']).map((k) => `${k.prefix}-${k.number}`);
    expect(keys('Fix TM-12, tm-13 and [TM-14]')).toEqual(['TM-12', 'TM-13', 'TM-14']);
    expect(keys('feature/TM-12-hero TM-12 again')).toEqual(['TM-12']);
    expect(keys('XTM-1 TM-0 AB-5 TM-')).toEqual([]);
    expect(keys(Array.from({ length: 15 }, (_, i) => `TM-${i + 1}`).join(' '))).toHaveLength(10);
    expect([normalizeWorkKeyPrefix(' tm '), normalizeWorkKeyPrefix('1A')]).toEqual(['TM', null]);
  });
});
