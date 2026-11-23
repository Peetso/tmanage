import { describe, expect, it } from 'vitest';
import { pluralPhrase } from '../src/lib/i18n/plural';

describe('pluralPhrase (R34 D1/D2)', () => {
  const english = { one: 'One organization', other: '{count} organizations' };
  const catalog: Record<string, string> = {
    'x.two': 'مؤسستان',
    'x.few': '{count} مؤسسات',
  };
  const tr = (key: string, fallback: string) => catalog[key] ?? fallback;

  it('picks the locale plural form, Latin digits by default (AR-DIGITS), and the English pair until a key exists', () => {
    expect(pluralPhrase(tr, 'ar-EG', 'x', 2, english)).toBe('مؤسستان');
    expect(pluralPhrase(tr, 'ar-EG', 'x', 3, english)).toBe('3 مؤسسات');
    expect(pluralPhrase(tr, 'en-US', 'x', 1, english)).toBe('One organization');
    expect(pluralPhrase(tr, 'en-US', 'x', 50, english, '50+')).toBe('50+ organizations');
  });
});
