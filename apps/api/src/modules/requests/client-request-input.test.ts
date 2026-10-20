import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { parseSubmitBody, slugifyCategory } from './client-request-input.js';

/**
 * REQ-05: the client's category is free text, folded to the audit-safe slug here rather than
 * refused. The audit boundary only ever sees `[a-z0-9-]`, so the write can never 500 on a space.
 */
describe('slugifyCategory', () => {
  it('folds free text to a hyphenated, lowercase slug', () => {
    expect(slugifyCategory('New page')).toBe('new-page');
    expect(slugifyCategory('Bug report!')).toBe('bug-report');
    expect(slugifyCategory('  Lots   of   spaces  ')).toBe('lots-of-spaces');
  });

  it('leaves an already-slug value unchanged', () => {
    expect(slugifyCategory('bug_report')).toBe('bug_report');
    expect(slugifyCategory('new-page')).toBe('new-page');
  });

  it('returns undefined when nothing survives the fold', () => {
    expect(slugifyCategory('!!!')).toBeUndefined();
    expect(slugifyCategory('   ')).toBeUndefined();
  });

  it('caps the slug at the column width without a dangling hyphen', () => {
    const slug = slugifyCategory('x'.repeat(40) + ' ' + 'y'.repeat(40));
    expect(slug).toBeDefined();
    expect((slug ?? '').length).toBeLessThanOrEqual(64);
    expect((slug ?? '').endsWith('-')).toBe(false);
  });
});

describe('parseSubmitBody category', () => {
  const base = {
    projectId: 'p1',
    title: 'Add a careers page',
    description: 'We need a careers page.',
  };

  it('accepts a sentence and stores its slug', () => {
    const parsed = parseSubmitBody({ ...base, category: 'A whole sentence here' });
    expect(parsed.category).toBe('a-whole-sentence-here');
  });

  it('omits the category when the free text folds to nothing', () => {
    const parsed = parseSubmitBody({ ...base, category: '***' });
    expect(parsed.category).toBeUndefined();
  });

  it('still refuses a non-string category', () => {
    expect(() => parseSubmitBody({ ...base, category: 42 })).toThrow(ApiError);
  });
});
