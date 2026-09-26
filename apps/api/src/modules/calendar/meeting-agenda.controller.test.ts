import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MeetingAgendaController } from './meeting-agenda.controller.js';
import type { MeetingAgendaRepository } from './meeting-agenda.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';

/**
 * CAL agenda / day view (x127). The controller's own logic, database-free over fakes with the
 * **real** `authorize()`. The tenant-scoped SQL round-trip and the migration are the chain's
 * concern (no DB test in this slice); here the subject is what the controller does with the rows a
 * read hands it — the day grouping, the relation filter, and the clamped window.
 *
 * The fake `listInWindow` deliberately does **not** apply the tenant scope or the window the real
 * SQL applies, so a cross-tenant row reaches the controller and its `authorize()` filter must drop
 * it — belt-and-braces to the scoped query, exactly as the meetings service test does.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

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

function meeting(id: string, startsAt: string, over: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    title: `Meeting ${id}`,
    startsAt: new Date(startsAt),
    agendaNote: null,
    createdByUserId: USER,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  } as MeetingRow;
}

/** A controller over an in-memory store whose `listInWindow` omits the tenant scope on purpose. */
function controllerWith(seed: readonly MeetingRow[] = []): MeetingAgendaController {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const agenda = {
    listInWindow: async () => [...seed],
  } as unknown as MeetingAgendaRepository;
  return new MeetingAgendaController(database, agenda);
}

describe('MeetingAgendaController', () => {
  it('requires the meeting.read capability on the agenda route (403 for a role without it)', () => {
    // The 403 is the CapabilityGuard's, keyed off this metadata; a route without it would be
    // refused outright rather than run unguarded.
    const capability = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      MeetingAgendaController.prototype.agendaView,
    );
    expect(capability).toBe('meeting.read');
  });

  it('groups meetings by their start day, ascending, preserving the within-day order', async () => {
    const controller = controllerWith([
      meeting('meeting-0000-0000-0000-000000000001', '2026-10-01T09:00:00.000Z'),
      meeting('meeting-0000-0000-0000-000000000002', '2026-10-01T14:00:00.000Z'),
      meeting('meeting-0000-0000-0000-000000000003', '2026-10-03T10:00:00.000Z'),
    ]);

    const view = await controller.agendaView(context, member([PROJECT]), '2026-10-01', '2026-10-31');

    expect(view.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(view.days.map((day) => day.date)).toEqual(['2026-10-01', '2026-10-03']);
    expect(view.days[0]?.meetings.map((m) => m.id)).toEqual([
      'meeting-0000-0000-0000-000000000001',
      'meeting-0000-0000-0000-000000000002',
    ]);
    expect(view.days[1]?.meetings.map((m) => m.id)).toEqual([
      'meeting-0000-0000-0000-000000000003',
    ]);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(view)).not.toContain(ORG);
  });

  it('drops a cross-tenant row and a non-member project (the relation filter)', async () => {
    const controller = controllerWith([
      meeting('meeting-0000-0000-0000-000000000010', '2026-10-02T09:00:00.000Z'),
      meeting('meeting-foreign-000000000000000011', '2026-10-02T10:00:00.000Z', {
        organizationId: OTHER_ORG,
      }),
    ]);

    // A member of no project sees nothing; an org-wide role sees the in-tenant row only.
    const asNonMember = await controller.agendaView(
      context,
      member([]),
      '2026-10-01',
      '2026-10-31',
    );
    expect(asNonMember.days).toEqual([]);

    const asOwner = await controller.agendaView(context, member([], true), '2026-10-01', '2026-10-31');
    expect(asOwner.days.flatMap((day) => day.meetings.map((m) => m.id))).toEqual([
      'meeting-0000-0000-0000-000000000010',
    ]);
    expect(JSON.stringify(asOwner)).not.toContain(OTHER_ORG);
  });

  it('refuses an over-wide window with a 400', async () => {
    const controller = controllerWith();
    const error = await controller
      .agendaView(context, member([PROJECT]), '2026-10-01', '2026-12-01')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
  });

  it('refuses a missing or malformed range with a 400', async () => {
    const controller = controllerWith();
    for (const [from, to] of [
      [undefined, '2026-10-31'],
      ['2026-10-31', '2026-10-01'], // to before from
      ['not-a-date', '2026-10-31'],
    ] as const) {
      const error = await controller
        .agendaView(context, member([PROJECT]), from, to)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(400);
    }
  });
});
