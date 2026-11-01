import { describe, expect, it } from 'vitest';
import { parseUserIds, presenceView } from './presence.service.js';

const USER = '0198f100-0000-7000-8000-0000000000a1';
const seen = new Date('2026-11-01T14:02:00.000Z');

describe('R7 presence', () => {
  it('hides online and last seen when the person turned the preference off', () => {
    const base = { userId: USER, lastSeenAt: seen, online: true };
    expect(presenceView(USER, { ...base, showLastSeen: 'false' })).toEqual({
      userId: USER,
      online: false,
      lastSeenAt: null,
    });
    expect(presenceView(USER, { ...base, showLastSeen: null }).lastSeenAt).toBe(seen.toISOString());
  });

  it('refuses a malformed id list', () => {
    expect(() => parseUserIds('not-an-id')).toThrow();
    expect(parseUserIds(`${USER},${USER}`)).toEqual([USER]);
  });
});
