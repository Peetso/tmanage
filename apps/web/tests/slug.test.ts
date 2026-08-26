import { describe, expect, it } from 'vitest';
import {
  MAX_ORGANIZATION_NAME_LENGTH,
  MAX_SLUG_LENGTH,
  describeSlugProblems,
  slugProblems,
  slugify,
} from '../src/lib/slug';

describe('slugify', () => {
  it.each([
    ['Northstar Studio', 'northstar-studio'],
    ['  Atlas   Hospitality  ', 'atlas-hospitality'],
    ['Café Rouge', 'cafe-rouge'],
    ['Smith & Co.', 'smith-co'],
    ['ACME', 'acme'],
    ['a---b', 'a-b'],
    ['---', ''],
    ['', ''],
  ])('%o becomes %o', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('never produces a leading or trailing hyphen', () => {
    for (const input of ['-lead', 'trail-', ' -both- ', '!!!x!!!']) {
      const slug = slugify(input);
      expect(slug.startsWith('-')).toBe(false);
      expect(slug.endsWith('-')).toBe(false);
    }
  });

  /**
   * The interesting case: truncating at the limit can land on a hyphen, which would produce
   * an invalid hostname label. The trailing hyphen has to be removed *after* the cut, not
   * before it.
   */
  it('does not leave a hyphen behind when it truncates', () => {
    const name = `${'a'.repeat(MAX_SLUG_LENGTH - 1)} bbbb`;
    const slug = slugify(name);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('produces something the column can hold', () => {
    // `organizations.slug` is varchar(63). The two numbers must be the same number.
    expect(MAX_SLUG_LENGTH).toBe(63);
    expect(slugify('x'.repeat(500)).length).toBeLessThanOrEqual(63);
  });

  it('states the name column width so a form can stop before the database does', () => {
    // `organizations.name` is varchar(190) in 0001_tenancy.sql and schema.ts.
    expect(MAX_ORGANIZATION_NAME_LENGTH).toBe(190);
  });
});

describe('slugProblems', () => {
  it('accepts a well-formed slug', () => {
    expect(slugProblems('northstar-studio')).toEqual([]);
  });

  it('reports every problem at once rather than the first', () => {
    const problems = slugProblems(`-${'A'.repeat(MAX_SLUG_LENGTH)}-`);
    expect(problems).toContain('too-long');
    expect(problems).toContain('invalid-characters');
    expect(problems).toContain('edge-hyphen');
  });

  it.each([
    ['', 'empty'],
    ['Has Capitals', 'invalid-characters'],
    ['under_score', 'invalid-characters'],
    ['-lead', 'edge-hyphen'],
  ] as const)('%o is %s', (slug, problem) => {
    expect(slugProblems(slug)).toContain(problem);
  });

  it('does not report "empty" as a character problem', () => {
    expect(slugProblems('')).toEqual(['empty']);
  });
});

describe('describeSlugProblems', () => {
  it('says nothing when there is nothing to say', () => {
    expect(describeSlugProblems([])).toBeUndefined();
  });

  it('joins one sentence per problem', () => {
    const sentence = describeSlugProblems(['invalid-characters', 'edge-hyphen']);
    expect(sentence).toContain('lowercase letters');
    expect(sentence).toContain('hyphen');
  });
});
