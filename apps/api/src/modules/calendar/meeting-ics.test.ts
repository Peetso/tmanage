import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { serializeMeetingIcs } from './meeting-ics.js';
import { MeetingsService } from './meetings.service.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';

/**
 * CAL — ICS export (x128). One unit test per key behaviour (budget 0.05):
 *  - the pure serializer emits a valid, RFC-5545-escaped VEVENT for a fixture;
 *  - `MeetingsService.get` runs the *real* `authorize()`: a cross-tenant/unknown meeting is 404;
 *  - a project member reads the meeting back as the wire projection (no tenant id).
 *
 * The `text/calendar` response bytes, the content-disposition and the route's `meeting.read`
 * ceiling (403 without the capability) are the guard's and the framework's, exercised by the
 * live e2e the chain owns; here the subject is the render and the object-level authorization.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const STARTS_AT = new Date('2026-10-01T14:00:00.000Z');

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/**
 * A service over an in-memory store whose `findById` deliberately does **not** apply the tenant
 * scope the real SQL applies, so a cross-tenant row still reaches the service and its `authorize()`
 * relation gate must reject it — belt-and-braces to the scoped query.
 */
function serviceWith(seed: readonly MeetingRow[]): MeetingsService {
  const store = [...seed];
  const database = {
    read: async (_ctx: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    findById: async (_runner: unknown, _ctx: unknown, meetingId: string) =>
      store.find((row) => row.id === meetingId) ?? null,
  } as unknown as MeetingsRepository;
  const projects = {} as unknown as ProjectsRepository;
  return new MeetingsService(database, repository, projects);
}

function meetingRow(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: 'meeting-0000-0000-0000-000000000010',
    organizationId: ORG,
    projectId: PROJECT,
    title: 'Kickoff',
    startsAt: STARTS_AT,
    agendaNote: null,
    createdByUserId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MeetingRow;
}

describe('serializeMeetingIcs', () => {
  it('emits a valid VEVENT with UTC instants and RFC-5545-escaped text', () => {
    const ics = serializeMeetingIcs({
      uid: 'meeting-1',
      // Special characters that MUST be escaped: comma, semicolon, backslash, newline.
      summary: 'Kickoff, phase 1; plan\\draft\nline two',
      startsAt: new Date('2026-10-01T14:00:00.000Z'),
      endsAt: new Date('2026-10-01T15:00:00.000Z'),
      stamp: new Date('2026-09-26T09:00:00.000Z'),
    });

    // Structure and CRLF line endings.
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('BEGIN:VEVENT\r\n');
    expect(ics).toContain('END:VEVENT\r\n');
    expect(ics).toContain('VERSION:2.0\r\n');

    // UTC date-times, form YYYYMMDDTHHMMSSZ.
    expect(ics).toContain('UID:meeting-1\r\n');
    expect(ics).toContain('DTSTART:20261001T140000Z\r\n');
    expect(ics).toContain('DTEND:20261001T150000Z\r\n');
    expect(ics).toContain('DTSTAMP:20260926T090000Z\r\n');

    // Escaping: comma -> \, ; semicolon -> \; ; backslash -> \\ ; newline -> \n .
    expect(ics).toContain('SUMMARY:Kickoff\\, phase 1\\; plan\\\\draft\\nline two\r\n');
  });

  it('folds a content line longer than 75 octets with CRLF + space', () => {
    const ics = serializeMeetingIcs({
      uid: 'meeting-2',
      summary: 'x'.repeat(200),
      startsAt: STARTS_AT,
      endsAt: STARTS_AT,
      stamp: STARTS_AT,
    });
    // No unfolded line exceeds the 75-octet limit.
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Continuation lines begin with a single space.
    expect(ics).toContain('\r\n x');
  });
});

describe('MeetingsService.get (ICS read authorization)', () => {
  it('returns a cross-tenant or unknown meeting as not-found, never a 500 (Known trap)', async () => {
    const foreign = meetingRow({
      id: 'meeting-foreign-000000000000000001',
      organizationId: OTHER_ORG,
    });
    const service = serviceWith([foreign]);

    const error = await service
      .get(context, member([PROJECT], true), foreign.id)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('hides a project’s meeting from a non-member as not-found (relation), not a 403', async () => {
    const service = serviceWith([meetingRow()]);
    const error = await service
      .get(context, member([]), 'meeting-0000-0000-0000-000000000010')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
  });

  it('returns the wire projection for a project member, never echoing the tenant id', async () => {
    const service = serviceWith([meetingRow()]);
    const view = await service.get(
      context,
      member([PROJECT]),
      'meeting-0000-0000-0000-000000000010',
    );

    expect(view.id).toBe('meeting-0000-0000-0000-000000000010');
    expect(view.title).toBe('Kickoff');
    expect(view.startsAt).toBe(STARTS_AT.toISOString());
    expect(JSON.stringify(view)).not.toContain(ORG);
  });
});
