import { describe, expect, it } from 'vitest';
import { formatLastActivity, initialsOf } from '../src/components/chat/channel-browser';

describe('CH-01 row labels', () => {
  it('labels last activity the way the design does', () => {
    const now = Date.parse('2026-10-18T12:00:00.000Z');
    expect(formatLastActivity('2026-10-18T11:58:00.000Z', now)).toBe('2 min ago');
    expect(formatLastActivity('2026-10-18T11:00:00.000Z', now)).toBe('1 hour ago');
    expect(formatLastActivity('2026-06-01T12:00:00.000Z', now)).toBe('4 months ago');
    expect(formatLastActivity('2026-10-18T11:59:30.000Z', now)).toBe('just now');
  });

  it('draws two initials from a display name', () => {
    expect(initialsOf('Omar Abdel Aziz')).toBe('OA');
    expect(initialsOf('lina')).toBe('LI');
  });
});
