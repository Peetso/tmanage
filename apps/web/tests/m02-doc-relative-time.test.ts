import { describe, expect, it } from 'vitest';
import { formatRelative } from '../src/components/screens/DocumentViewScreen';

describe('C2 docs byline age', () => {
  it('speaks the active locale, not the browser default', () => {
    const now = new Date().toISOString();
    expect(formatRelative(now, 'ar')).not.toMatch(/minute/);
    expect(formatRelative(now, 'en')).toBe('this minute');
  });
});
