import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { normaliseCallUrl, planAttendance } from './meeting-join.js';
import { MeetingJoinService } from './meeting-join.service.js';

describe('53-12 meeting join', () => {
  it('allows only https meeting hosts, never look-alikes or other schemes', () => {
    expect(normaliseCallUrl('https://meet.google.com/abc-defg-hij')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(normaliseCallUrl('https://us02web.zoom.us/j/1')).toBe('https://us02web.zoom.us/j/1');
    for (const bad of [
      'http://meet.google.com/x',
      'javascript:alert(1)',
      'https://meet.google.com.evil.io/x',
      'https://u:p@meet.jit.si/x',
      'https://meet.jit.si:8443/x',
      'https://127.0.0.1/x',
    ]) {
      expect(normaliseCallUrl(bad)).toBeNull();
    }
  });

  it('records attendance once per join window: a second click keeps the first join time', () => {
    const first = new Date('2026-11-16T08:00:00Z');
    const later = new Date('2026-11-16T08:20:00Z');
    expect(planAttendance(null, first)).toEqual({ kind: 'insert', joinedAt: first });
    expect(planAttendance({ firstJoinedAt: first }, later)).toEqual({
      kind: 'touch',
      firstJoinedAt: first,
      lastJoinedAt: later,
    });
  });

  it('refuses Join to someone who can read the project but is not invited, with no link', async () => {
    const meeting = {
      id: 'm1',
      organizationId: 'o1',
      projectId: 'p1',
      deletedAt: null,
      cancelledAt: null,
      startsAt: new Date(),
      endsAt: null,
    };
    const database = {
      read: (_c: unknown, fn: (r: unknown) => unknown) => fn({}),
    } as unknown as TenantDatabase;
    const service = new MeetingJoinService(
      database,
      { findById: async () => meeting } as never,
      {
        roster: async () => [{ kind: 'member', userId: 'someone-else' }],
        findLink: async () => ({ joinUrl: 'https://meet.google.com/a' }),
      } as never,
    );
    const principal = {
      userId: 'u1',
      organizationId: 'o1',
      kind: 'internal',
      role: 'owner',
      membershipId: 'mb',
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: [],
      hasOrgWideScope: true,
    } as unknown as Principal;
    const refused = await service
      .joinAsMember({ organizationId: 'o1' } as TenantContext, principal, 'm1')
      .catch((e: { status: number; message: string }) => e);
    expect(refused).toMatchObject({ status: 403 });
    expect(JSON.stringify(refused)).not.toContain('meet.google.com');
  });
});
