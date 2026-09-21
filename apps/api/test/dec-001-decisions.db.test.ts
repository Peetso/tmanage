import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import { DecisionsRepository } from '../src/modules/decisions/decisions.repository.js';
import { MeetingsRepository } from '../src/modules/calendar/meetings.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * DEC-01 (x113). The decisions repository against a real server and the adversarial near-identical
 * tenant pair the isolation corpus uses. Under test: the migration applies and a tenant-scoped
 * decision round-trips (an author then a scoped list/findById, most recently decided first); a
 * meeting of the same tenant/project links; and the tenant guard is genuinely on the Drizzle path
 * (an unscoped `SELECT ... FROM decisions` still throws, naming the table). The pair's ids differ
 * only in the final hex digit, so a missing predicate would leak rather than pass.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;
const repository = new DecisionsRepository();
const meetingsRepository = new MeetingsRepository();

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

const EARLIER = new Date('2026-01-01T09:00:00.000Z');
const LATER = new Date('2026-06-01T09:00:00.000Z');

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

describe('a tenant-scoped decision round-trips', () => {
  it('authors in the acting tenant and reads it back most-recently-decided first', async () => {
    const earlier = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Earlier decision',
        statement: 'The first thing we decided.',
        status: 'proposed',
        decidedBy: world.northstar.owner.id,
        decidedAt: EARLIER,
      }),
    );
    const later = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Later decision',
        statement: 'The next thing we decided.',
        status: 'accepted',
        decidedBy: world.northstar.owner.id,
        decidedAt: LATER,
      }),
    );

    expect(earlier.organizationId).toBe(northstar.organizationId);
    expect(later.decidedAt).toBeInstanceOf(Date);

    const listed = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { projectId: world.northstar.projectId }),
    );
    const ids = listed.map((row) => row.id);
    // Most recently decided first.
    expect(ids.indexOf(later.id)).toBeLessThan(ids.indexOf(earlier.id));
    expect(listed.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
  });

  it('links a meeting of the same tenant and project via the nullable composite key', async () => {
    const meeting = await tenant.transaction(northstar, (tx) =>
      meetingsRepository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Decision meeting',
        startsAt: LATER,
        createdByUserId: world.northstar.owner.id,
      }),
    );
    const decision = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        meetingId: meeting.id,
        title: 'Decided in the meeting',
        statement: 'Agreed live.',
        status: 'accepted',
        decidedBy: world.northstar.owner.id,
        decidedAt: LATER,
      }),
    );
    expect(decision.meetingId).toBe(meeting.id);
  });
});

describe('a decision never crosses a tenant boundary', () => {
  it('does not list the twin’s decision and returns null for a direct cross-tenant lookup', async () => {
    const twinDecision = await tenant.transaction(twin, (tx) =>
      repository.create(tx, twin, {
        projectId: world.twin.projectId,
        title: 'Twin decision',
        statement: 'Someone else’s decision.',
        status: 'proposed',
        decidedBy: world.twin.owner.id,
        decidedAt: LATER,
      }),
    );

    const mine = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { projectId: world.twin.projectId }),
    );
    expect(mine.map((row) => row.id)).not.toContain(twinDecision.id);

    const found = await tenant.read(northstar, (tx) =>
      repository.findById(tx, northstar, twinDecision.id),
    );
    expect(found).toBeNull();

    const reallyExists = await tenant.read(twin, (tx) =>
      repository.findById(tx, twin, twinDecision.id),
    );
    expect(reallyExists?.id).toBe(twinDecision.id);
  });

  it('cannot be told which tenant to write into', async () => {
    // Structural, not runtime: `CreateDecisionInput` has no `organizationId`, so this is a compile
    // error and the @ts-expect-error fails the typecheck gate if the field is added.
    await tenant.transaction(northstar, async (tx) => {
      const created = await repository.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Payload cannot choose the tenant',
        statement: 'x',
        status: 'proposed',
        decidedBy: world.northstar.owner.id,
        decidedAt: LATER,
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
        const { decisions } = await import('../src/common/database/schema.js');
        return tenantDrizzle(tx).select().from(decisions);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['decisions']);
  });
});
