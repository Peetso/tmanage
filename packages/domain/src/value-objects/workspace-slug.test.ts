import { describe, expect, it } from 'vitest';
import { latinForSlug } from './workspace-slug.js';

/** TESTUX P1 11: an Arabic workspace name is spelled in Latin for its address, not dropped. */
describe('latinForSlug', () => {
  it('spells Arabic letters in Latin, w/y at a word start and u/i inside it', () => {
    expect(latinForSlug('شركة النيل')).toBe('shrka alnil');
    expect(latinForSlug('نور للتصميم')).toBe('nur lltsmim');
    expect(latinForSlug('وادي')).toBe('wadi');
  });

  it('drops the vowel marks and the tatweel, and turns Arabic-Indic digits into 0-9', () => {
    expect(latinForSlug('مَـكتب ٢٠٢٦')).toBe('mktb 2026');
    expect(latinForSlug('۱۲')).toBe('12');
  });

  it('spells the Urdu letters and leaves Latin text as it is', () => {
    expect(latinForSlug('پاکستان')).toBe('pakstan');
    expect(latinForSlug('Nile Studio')).toBe('Nile Studio');
  });
});
