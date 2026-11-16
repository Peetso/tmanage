import { describe, expect, it } from 'vitest';
import {
  parsePublicLinkExpiry,
  parsePublicLinkIds,
  parsePublicLinkManagerQuery,
  publicLinkManagedStatus,
} from './public-link-manager.js';

const ID = '0190f000-0000-7000-8000-0000000000d1';
const NOW = new Date('2026-11-16T10:00:00.000Z');
const DAY = 86_400_000;

describe('56-07p public link manager parsing', () => {
  it('reads the list query with defaults and refuses a kind the workspace does not issue', () => {
    expect(parsePublicLinkManagerQuery({}, ['approval'])).toEqual({
      ok: true,
      value: { search: null, kind: null, createdBy: null, state: 'active', page: 1 },
    });
    expect(parsePublicLinkManagerQuery({ kind: 'magic_signin' }, ['approval'])).toMatchObject({
      ok: false,
      field: 'kind',
    });
    for (const bad of [{ createdBy: 'me' }, { state: 'gone' }, { page: '0' }]) {
      expect(parsePublicLinkManagerQuery(bad, ['approval']).ok).toBe(false);
    }
  });

  it('takes 1 to 100 link ids, deduplicated, and an end within 30 days', () => {
    expect(parsePublicLinkIds({ linkIds: [ID, ID] })).toEqual({ ok: true, value: [ID] });
    expect(parsePublicLinkIds({ linkIds: [] }).ok).toBe(false);
    expect(parsePublicLinkIds({ linkIds: ['x'] }).ok).toBe(false);
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(parsePublicLinkExpiry({ linkIds: [ID], expiresAt: at(7 * DAY) }, NOW).ok).toBe(true);
    expect(parsePublicLinkExpiry({ linkIds: [ID], expiresAt: at(-1) }, NOW).ok).toBe(false);
    expect(parsePublicLinkExpiry({ linkIds: [ID], expiresAt: at(32 * DAY) }, NOW).ok).toBe(false);
  });

  it('shows revoked, answered, used and expired before active or ending soon', () => {
    const row = { revokedAt: null, decision: null, maxUses: null, uses: 0 };
    const ends = (ms: number) => new Date(NOW.getTime() + ms);
    expect(publicLinkManagedStatus({ ...row, expiresAt: ends(10 * DAY) }, NOW)).toBe('active');
    expect(publicLinkManagedStatus({ ...row, expiresAt: ends(DAY) }, NOW)).toBe('ending_soon');
    expect(publicLinkManagedStatus({ ...row, expiresAt: ends(-1) }, NOW)).toBe('expired');
    expect(publicLinkManagedStatus({ ...row, revokedAt: NOW, expiresAt: ends(DAY) }, NOW)).toBe(
      'revoked',
    );
  });
});
