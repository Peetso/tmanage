import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { MeetingsRepository } from '../src/modules/calendar/meetings.repository.js';
import { MeetingNotesRepository } from '../src/modules/calendar/meeting-notes.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * CAL-01 / MTG-01 second slice (x105). The meeting-notes repository against a real server and the
 * adversarial near-identical tenant pair the isolation corpus uses. Under test: the migration
 * applies and a tenant-scoped note **and** decision round-trip against a meeting (create then a
 * scoped, deterministically ordered list), the tenant guard is genuinely on the Drizzle path (an
 * unscoped `SELECT ... FROM meeting_notes` still throws), and the composite foreign key refuses a
 * note that cites a meeting from another tenant. The pair's ids differ only in the final hex
 * digit, so a missing predicate would leak rather than pass.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;
const meetingsRepo = new MeetingsRepository();
const notesRepo = new MeetingNotesRepository();

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-16',
    correlationId: uuidv7(),
  });

const STARTS_AT = new Date('2026-10-01T14:00:00.000Z');

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents = [];
  tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: (event) => guardEvents.push(event),
  });
  northstar = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
  twin = contextFor(world.twin.organizationId, world.twin.owner.id, world.twin.owner.membershipId);
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

async function createMeeting(context: TenantContext, projectId: string, userId: string) {
  return tenant.transaction(context, (tx) =>
    meetingsRepo.create(tx, context, {
      projectId,
      title: 'Kickoff',
      startsAt: STARTS_AT,
      createdByUserId: userId,
    }),
  );
}

describe('a tenant-scoped note and decision round-trip against a meeting', () => {
  it('captures both kinds and reads them back scoped to org and meeting, deterministically ordered', async () => {
    const meeting = await createMeeting(
      northstar,
      world.northstar.projectId,
      world.northstar.owner.id,
    );

    const note = await tenant.transaction(northstar, (tx) =>
      notesRepo.create(tx, northstar, {
        meetingId: meeting.id,
        kind: 'note',
        body: 'A loose note',
        authorUserId: world.northstar.owner.id,
      }),
    );
    const decision = await tenant.transaction(northstar, (tx) =>
      notesRepo.create(tx, northstar, {
        meetingId: meeting.id,
        kind: 'decision',
        body: 'We ship Friday',
        authorUserId: world.northstar.owner.id,
      }),
    );

    expect(note.organizationId).toBe(northstar.organizationId);
    expect(note.kind).toBe('note');
    expect(decision.kind).toBe('decision');
    expect(note.createdAt).toBeInstanceOf(Date);

    const listed = await tenant.read(northstar, (tx) =>
      notesRepo.list(tx, northstar, { meetingId: meeting.id }),
    );
    // Deterministic order: id (UUIDv7 ≈ creation order). The note was created before the decision.
    expect(listed.map((row) => row.id)).toEqual([note.id, decision.id]);
    expect(listed.map((row) => row.kind)).toEqual(['note', 'decision']);
    expect(listed.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
  });
});

describe('a note never crosses a tenant boundary', () => {
  it('does not list the twin’s note and returns null for a direct cross-tenant lookup', async () => {
    const twinMeeting = await createMeeting(twin, world.twin.projectId, world.twin.owner.id);
    const twinNote = await tenant.transaction(twin, (tx) =>
      notesRepo.create(tx, twin, {
        meetingId: twinMeeting.id,
        kind: 'note',
        body: 'Twin note',
        authorUserId: world.twin.owner.id,
      }),
    );

    const mine = await tenant.read(northstar, (tx) =>
      notesRepo.list(tx, northstar, { meetingId: twinMeeting.id }),
    );
    expect(mine.map((row) => row.id)).not.toContain(twinNote.id);

    const found = await tenant.read(northstar, (tx) =>
      notesRepo.findById(tx, northstar, twinNote.id),
    );
    expect(found).toBeNull();

    const reallyExists = await tenant.read(twin, (tx) => notesRepo.findById(tx, twin, twinNote.id));
    expect(reallyExists?.id).toBe(twinNote.id);
  });

  it('cannot cite a meeting from another tenant: the composite foreign key refuses it', async () => {
    // The twin's meeting id exists, but the pair (northstar org, twin meeting) does not — the
    // composite foreign key fk_meeting_notes_meeting_tenant refuses the row rather than letting a
    // note reach across the boundary. Written at the raw connection because the guard would also
    // reject an insert whose organization_id disagrees with the acting tenant; here the tenant
    // matches and the meeting is the cross-tenant value.
    const twinMeeting = await createMeeting(twin, world.twin.projectId, world.twin.owner.id);
    await expect(
      db.admin.query(
        `INSERT INTO meeting_notes (id, organization_id, meeting_id, kind, body, author_user_id)
         VALUES (?, ?, ?, 'note', 'x', ?)`,
        [uuidv7(), world.northstar.organizationId, twinMeeting.id, world.northstar.owner.id],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('cannot be told which tenant to write into', async () => {
    // Structural, not runtime: `CreateMeetingNoteInput` has no `organizationId`, so this is a
    // compile error and the @ts-expect-error fails the typecheck gate if the field is added.
    const meeting = await createMeeting(
      northstar,
      world.northstar.projectId,
      world.northstar.owner.id,
    );
    await tenant.transaction(northstar, async (tx) => {
      const created = await notesRepo.create(tx, northstar, {
        meetingId: meeting.id,
        kind: 'note',
        body: 'Payload cannot choose the tenant',
        authorUserId: world.northstar.owner.id,
        // @ts-expect-error organizationId is derived from TenantContext, never from input
        organizationId: twin.organizationId,
      });
      expect(created.organizationId).toBe(northstar.organizationId);
    });
  });
});

describe('the Drizzle seam keeps the tenant guard on the path', () => {
  it('throws when a Drizzle query omits the tenant predicate, and names the table', async () => {
    const before = guardEvents.length;
    await expect(
      tenant.read(northstar, async (tx) => {
        const { tenantDrizzle } = await import('../src/common/database/drizzle.js');
        const { meetingNotes } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(meetingNotes);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['meeting_notes']);
  });
});
