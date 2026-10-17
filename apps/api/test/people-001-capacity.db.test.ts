import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { PersonCapacityRepository } from '../src/modules/people/capacity.repository.js';
import { PersonAllocationsRepository } from '../src/modules/people/allocations.repository.js';
import {
  PersonSkillDuplicateError,
  PersonSkillsRepository,
} from '../src/modules/people/skills.repository.js';
import { MemberProfileRepository } from '../src/modules/people/member-profile.repository.js';
import { ReportingLinesRepository } from '../src/modules/people/reporting-lines.repository.js';
import { MemberAvailabilityRepository } from '../src/modules/people/availability.repository.js';
import { CapacityHeatmapRepository } from '../src/modules/people/capacity-heatmap.repository.js';
import { CapacityHeatmapService } from '../src/modules/people/capacity-heatmap.service.js';
import { ReportingLinesController } from '../src/modules/people/reporting-lines.controller.js';
import { MembershipsRepository } from '../src/modules/tenancy/memberships.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PEOPLE-001 against a real MariaDB 11.8 server — the People & capacity module (module 14; x170–x172,
 * x193, x216–x218) built in pass 21/23 but never proven by a DB suite. This slice is the proof.
 *
 * What only this suite can prove, against genuine InnoDB rather than a mock:
 *
 * 1. **Tenant isolation per table.** Northstar Studios (`twin`) differs from Northstar Studio only
 *    in the final id nibble and carries identical names. Every repository read run under the
 *    Northstar context returns 0 of the twin's rows — never a leak — while the admin pool confirms
 *    the twin's rows are physically present. Every cross-tenant *write* is refused at the engine by
 *    the composite `(organization_id, …)` foreign keys, not merely by the application.
 * 2. **CRUD round trips** through the real repositories for all six tables.
 * 3. **The allocation-sum-vs-capacity invariant** — the heatmap service folds each member's
 *    overlapping allocation percents against their weekly capacity, so an over-committed member is
 *    flagged `overAllocated` and under-committed one is not. The arithmetic only has meaning against
 *    rows a real engine stored with its real date and percent semantics.
 * 4. **Reporting-line acyclicity** — a self-line is refused at the engine (`CHECK`) and by the
 *    controller (400); a longer cycle (A→B→C→A) is refused by the controller's upward walk.
 * 5. **One skill per (member, label)** — the UNIQUE key refuses the duplicate; a different member or
 *    a different label is allowed.
 * 6. **Availability windows persist** — the `DATE` bounds round-trip exactly, order by start date,
 *    and a stored window is immutable at the engine (the 0096 trigger).
 *
 * Admin-pool inserts date rows from a bound `new Date(...)` / literal `'YYYY-MM-DD'` strings, never
 * the admin connection's SYSTEM clock (admin-pool-clock trap).
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let northstarCtx: TenantContext;
let twinCtx: TenantContext;
let owner: Principal;

const capacityRepo = new PersonCapacityRepository();
const allocationsRepo = new PersonAllocationsRepository();
const skillsRepo = new PersonSkillsRepository();
const profileRepo = new MemberProfileRepository();
const reportingRepo = new ReportingLinesRepository();
const availabilityRepo = new MemberAvailabilityRepository();
let heatmapService: CapacityHeatmapService;

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error, `expected an ApiError, got: ${String(error)}`).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return error as ApiError;
  }
  throw new Error(`expected a ${status} refusal and got success`);
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  heatmapService = new CapacityHeatmapService(tenant, new CapacityHeatmapRepository());

  northstarCtx = createTenantContext({
    organizationId: world.northstar.organizationId,
    userId: world.northstar.owner.id,
    membershipId: world.northstar.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  twinCtx = createTenantContext({
    organizationId: world.twin.organizationId,
    userId: world.twin.owner.id,
    membershipId: world.twin.owner.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
  owner = {
    userId: northstarCtx.userId,
    organizationId: northstarCtx.organizationId,
    kind: 'internal',
    role: 'owner',
    membershipId: northstarCtx.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
});

afterAll(async () => {
  await db?.stop();
});

describe('the server really is MariaDB 11.8', () => {
  it('reports MariaDB 11.8, so composite FKs and CHECKs are actually enforced', () => {
    expect(db.engine.name, 'the engine is the one the product runs on, MariaDB 11.8').toBe(
      'mariadb',
    );
    expect(db.engine.version, 'the engine is the one the product runs on, MariaDB 11.8').toMatch(
      /^11\.8\./,
    );
  });
});

describe('person_capacity — CRUD, the engine bound, and tenant isolation', () => {
  it('sets a member capacity, reads it back, and revises it in place (one row)', async () => {
    const set = await tenant.transaction(northstarCtx, (tx) =>
      capacityRepo.set(tx, northstarCtx, {
        membershipId: world.northstar.manager.membershipId,
        weeklyHours: 32,
        effectiveFrom: '2026-02-01',
      }),
    );
    expect(set.weeklyHours).toBe(32);
    expect(set.effectiveFrom).toBe('2026-02-01');

    const read = await tenant.read(northstarCtx, (tx) =>
      capacityRepo.findByMembership(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    expect(read?.weeklyHours).toBe(32);

    // A revision is an upsert on (organization_id, membership_id): still one active row.
    await tenant.transaction(northstarCtx, (tx) =>
      capacityRepo.set(tx, northstarCtx, {
        membershipId: world.northstar.manager.membershipId,
        weeklyHours: 20,
        effectiveFrom: '2026-03-01',
      }),
    );
    const revised = await tenant.read(northstarCtx, (tx) =>
      capacityRepo.findByMembership(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    expect(revised?.weeklyHours).toBe(20);
    expect(revised?.effectiveFrom).toBe('2026-03-01');

    const rows = await observe(
      `select count(*) as n from person_capacity where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.northstar.manager.membershipId],
    );
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  it('refuses weekly_hours outside [0,168] at the engine, bypassing the application', async () => {
    await expect(
      db.admin.execute(
        `insert into person_capacity (id, organization_id, membership_id, weekly_hours, effective_from, updated_at)
         values (?, ?, ?, 200, '2026-01-01', ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.designer.membershipId,
          new Date(),
        ],
      ),
    ).rejects.toThrow(/ck_person_capacity_weekly_hours|[Cc]heck constraint/);
  });

  it("holds the row's tenant immutable at the engine", async () => {
    const rows = await observe(
      `select id from person_capacity where organization_id = ? and membership_id = ?`,
      [world.northstar.organizationId, world.northstar.manager.membershipId],
    );
    const id = String(rows[0]?.['id']);
    await expect(
      db.admin.execute(`update person_capacity set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        id,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it('never reads the twin tenant capacity, though the admin pool confirms it exists', async () => {
    // Seed a capacity row for the twin owner, through the twin's own scoped context.
    await tenant.transaction(twinCtx, (tx) =>
      capacityRepo.set(tx, twinCtx, {
        membershipId: world.twin.owner.membershipId,
        weeklyHours: 40,
        effectiveFrom: '2026-01-01',
      }),
    );
    // The twin's row is invisible under the Northstar context (0 rows), by id.
    const leaked = await tenant.read(northstarCtx, (tx) =>
      capacityRepo.findByMembership(tx, northstarCtx, world.twin.owner.membershipId),
    );
    expect(leaked).toBeNull();
    // But it is physically present — the predicate hides it, not its absence.
    const present = await observe(
      `select count(*) as n from person_capacity where organization_id = ? and membership_id = ?`,
      [world.twin.organizationId, world.twin.owner.membershipId],
    );
    expect(Number(present[0]?.['n'])).toBe(1);
  });

  it('refuses a cross-tenant capacity write at the composite foreign key', async () => {
    await expect(
      tenant.transaction(northstarCtx, (tx) =>
        capacityRepo.set(tx, northstarCtx, {
          // A membership of the twin tenant, written under the Northstar context: the pair
          // (northstar_org, twin_membership) does not exist, so the FK refuses it.
          membershipId: world.twin.owner.membershipId,
          weeklyHours: 10,
          effectiveFrom: '2026-01-01',
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });
});

describe('person_allocations — CRUD, the engine bound, and tenant isolation', () => {
  it('creates an allocation, lists it, and finds it active', async () => {
    const created = await tenant.transaction(northstarCtx, (tx) =>
      allocationsRepo.create(tx, northstarCtx, {
        projectId: world.northstar.projectId,
        membershipId: world.northstar.manager.membershipId,
        percent: 40,
      }),
    );
    expect(created.percent).toBe(40);
    expect(created.endDate).toBeNull();

    const list = await tenant.read(northstarCtx, (tx) =>
      allocationsRepo.list(tx, northstarCtx, { projectId: world.northstar.projectId }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]?.membershipId).toBe(world.northstar.manager.membershipId);

    const active = await tenant.read(northstarCtx, (tx) =>
      allocationsRepo.findActiveForMember(
        tx,
        northstarCtx,
        world.northstar.projectId,
        world.northstar.manager.membershipId,
      ),
    );
    expect(active?.id).toBe(created.id);
  });

  it('refuses a percent outside [1,100] at the engine', async () => {
    await expect(
      db.admin.execute(
        `insert into person_allocations (id, organization_id, project_id, membership_id, percent, created_at)
         values (?, ?, ?, ?, 101, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.projectId,
          world.northstar.designer.membershipId,
          new Date(),
        ],
      ),
    ).rejects.toThrow(/chk_person_allocations_percent|[Cc]heck constraint/);
  });

  it('refuses a cross-tenant allocation at the composite project foreign key', async () => {
    await expect(
      tenant.transaction(northstarCtx, (tx) =>
        allocationsRepo.create(tx, northstarCtx, {
          // The twin's project under the Northstar context: (northstar_org, twin_project) is no row.
          projectId: world.twin.projectId,
          membershipId: world.northstar.manager.membershipId,
          percent: 10,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });

  it('lists 0 allocations for the twin project under the Northstar context', async () => {
    const list = await tenant.read(northstarCtx, (tx) =>
      allocationsRepo.list(tx, northstarCtx, { projectId: world.twin.projectId }),
    );
    expect(list).toHaveLength(0);
  });
});

describe('allocation sum vs capacity — the heatmap invariant', () => {
  it('flags an over-committed member and clears an under-committed one', async () => {
    // Lina: 40h/week, allocated 60% + 70% across two projects = 130% ⇒ over-committed.
    await tenant.transaction(northstarCtx, (tx) =>
      capacityRepo.set(tx, northstarCtx, {
        membershipId: world.northstar.designer.membershipId,
        weeklyHours: 40,
        effectiveFrom: '2026-01-01',
      }),
    );
    await tenant.transaction(northstarCtx, (tx) =>
      allocationsRepo.create(tx, northstarCtx, {
        projectId: world.northstar.projectId,
        membershipId: world.northstar.designer.membershipId,
        percent: 60,
      }),
    );
    await tenant.transaction(northstarCtx, (tx) =>
      allocationsRepo.create(tx, northstarCtx, {
        projectId: world.northstar.otherProjectId,
        membershipId: world.northstar.designer.membershipId,
        percent: 70,
      }),
    );

    // Maya: 40h/week, allocated a single 20% ⇒ comfortably within capacity.
    await tenant.transaction(northstarCtx, (tx) =>
      capacityRepo.set(tx, northstarCtx, {
        membershipId: world.northstar.owner.membershipId,
        weeklyHours: 40,
        effectiveFrom: '2026-01-01',
      }),
    );
    await tenant.transaction(northstarCtx, (tx) =>
      allocationsRepo.create(tx, northstarCtx, {
        projectId: world.northstar.projectId,
        membershipId: world.northstar.owner.membershipId,
        percent: 20,
      }),
    );

    const view = await heatmapService.build(northstarCtx, owner, { from: '2026-01-05', weeks: 1 });

    const lina = view.members.find((m) => m.membershipId === world.northstar.designer.membershipId);
    expect(lina?.cells[0]?.allocatedPercent).toBe(130);
    expect(lina?.cells[0]?.capacityHours).toBe(40);
    expect(lina?.cells[0]?.allocatedHours).toBe(52);
    expect(lina?.cells[0]?.utilisation).toBe(1.3);
    expect(lina?.cells[0]?.overAllocated).toBe(true);

    const maya = view.members.find((m) => m.membershipId === world.northstar.owner.membershipId);
    expect(maya?.cells[0]?.allocatedPercent).toBe(20);
    expect(maya?.cells[0]?.overAllocated).toBe(false);
    expect(maya?.cells[0]?.utilisation).toBe(0.2);

    // The heatmap is tenant-scoped: the twin's rows never reach it (no twin membership appears).
    const twinLeak = view.members.find((m) => m.membershipId === world.twin.owner.membershipId);
    expect(twinLeak).toBeUndefined();
  });
});

describe('person_skills — CRUD, uniqueness, and tenant isolation', () => {
  it('adds skills, lists them, and removes one', async () => {
    await tenant.transaction(northstarCtx, (tx) =>
      skillsRepo.create(tx, northstarCtx, {
        membershipId: world.northstar.manager.membershipId,
        label: 'TypeScript',
        level: 'expert',
      }),
    );
    const second = await tenant.transaction(northstarCtx, (tx) =>
      skillsRepo.create(tx, northstarCtx, {
        membershipId: world.northstar.manager.membershipId,
        label: 'Copywriting',
        level: 'basic',
      }),
    );

    const list = await tenant.read(northstarCtx, (tx) =>
      skillsRepo.listForMember(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    // Label-ascending: Copywriting before TypeScript.
    expect(list.map((s) => s.label)).toEqual(['Copywriting', 'TypeScript']);

    const removed = await tenant.transaction(northstarCtx, (tx) =>
      skillsRepo.deleteSkill(tx, northstarCtx, world.northstar.manager.membershipId, second.id),
    );
    expect(removed).toBe(true);
    const afterDelete = await tenant.read(northstarCtx, (tx) =>
      skillsRepo.listForMember(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    expect(afterDelete.map((s) => s.label)).toEqual(['TypeScript']);
  });

  it('refuses a duplicate (member, label) but allows the label for another member', async () => {
    await expect(
      tenant.transaction(northstarCtx, (tx) =>
        skillsRepo.create(tx, northstarCtx, {
          membershipId: world.northstar.manager.membershipId,
          label: 'TypeScript',
          level: 'proficient',
        }),
      ),
    ).rejects.toBeInstanceOf(PersonSkillDuplicateError);

    // The same label for a different member is a different skill, not a duplicate.
    const otherMember = await tenant.transaction(northstarCtx, (tx) =>
      skillsRepo.create(tx, northstarCtx, {
        membershipId: world.northstar.designer.membershipId,
        label: 'TypeScript',
        level: 'basic',
      }),
    );
    expect(otherMember.label).toBe('TypeScript');
  });

  it('never reads the twin skills, and refuses a cross-tenant skill write', async () => {
    // Seed a skill for the twin owner, under the twin context.
    await tenant.transaction(twinCtx, (tx) =>
      skillsRepo.create(tx, twinCtx, {
        membershipId: world.twin.owner.membershipId,
        label: 'TypeScript',
        level: 'expert',
      }),
    );
    // Invisible under Northstar: listing the twin membership returns 0 rows.
    const leaked = await tenant.read(northstarCtx, (tx) =>
      skillsRepo.listForMember(tx, northstarCtx, world.twin.owner.membershipId),
    );
    expect(leaked).toHaveLength(0);
    // The twin membership resolves to null under Northstar (the controller's 404 path).
    const resolved = await tenant.read(northstarCtx, (tx) =>
      skillsRepo.findMembership(tx, northstarCtx, world.twin.owner.membershipId),
    );
    expect(resolved).toBeNull();
    // A cross-tenant write is refused at the composite member FK.
    await expect(
      tenant.transaction(northstarCtx, (tx) =>
        skillsRepo.create(tx, northstarCtx, {
          membershipId: world.twin.owner.membershipId,
          label: 'Smuggled',
          level: 'basic',
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });
});

describe('member_profiles — CRUD and tenant isolation', () => {
  it('upserts a profile, reads it back, and replaces it in place', async () => {
    const member = await tenant.read(northstarCtx, (tx) =>
      profileRepo.resolveMember(tx, northstarCtx, world.northstar.designer.membershipId),
    );
    expect(member?.userId).toBe(world.northstar.designer.id);

    await tenant.transaction(northstarCtx, (tx) =>
      profileRepo.upsertProfile(tx, northstarCtx, world.northstar.designer.id, {
        department: 'Design',
        bio: 'Lead product designer',
        contactEmail: 'lina.design@northstar.example',
        contactPhone: null,
      }),
    );
    let fields = await tenant.read(northstarCtx, (tx) =>
      profileRepo.findProfile(tx, northstarCtx, world.northstar.designer.id),
    );
    expect(fields.department).toBe('Design');
    expect(fields.bio).toBe('Lead product designer');

    // A second PUT is a full replacement against uq_member_profiles_org_user: still one row.
    await tenant.transaction(northstarCtx, (tx) =>
      profileRepo.upsertProfile(tx, northstarCtx, world.northstar.designer.id, {
        department: 'Brand',
        bio: null,
        contactEmail: null,
        contactPhone: '+20 100 000 0000',
      }),
    );
    fields = await tenant.read(northstarCtx, (tx) =>
      profileRepo.findProfile(tx, northstarCtx, world.northstar.designer.id),
    );
    expect(fields.department).toBe('Brand');
    expect(fields.bio).toBeNull();
    expect(fields.contactPhone).toBe('+20 100 000 0000');

    const rows = await observe(
      `select count(*) as n from member_profiles where organization_id = ? and user_id = ?`,
      [world.northstar.organizationId, world.northstar.designer.id],
    );
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  it('never reads the twin profile and resolves a twin membership to null', async () => {
    await tenant.transaction(twinCtx, (tx) =>
      profileRepo.upsertProfile(tx, twinCtx, world.twin.owner.id, {
        department: 'Secret',
        bio: null,
        contactEmail: null,
        contactPhone: null,
      }),
    );
    // Northstar reading the twin user's profile sees all-null (no row for this tenant).
    const fields = await tenant.read(northstarCtx, (tx) =>
      profileRepo.findProfile(tx, northstarCtx, world.twin.owner.id),
    );
    expect(fields).toEqual({
      department: null,
      bio: null,
      contactEmail: null,
      contactPhone: null,
    });
    // The twin membership does not resolve under Northstar.
    const member = await tenant.read(northstarCtx, (tx) =>
      profileRepo.resolveMember(tx, northstarCtx, world.twin.owner.membershipId),
    );
    expect(member).toBeNull();
  });

  it('refuses a cross-tenant profile write at the composite member foreign key', async () => {
    await expect(
      tenant.transaction(northstarCtx, (tx) =>
        profileRepo.upsertProfile(tx, northstarCtx, world.twin.owner.id, {
          department: 'Smuggled',
          bio: null,
          contactEmail: null,
          contactPhone: null,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });
});

describe('member_reporting_lines — CRUD, self-line, and cycles', () => {
  const controller = () =>
    new ReportingLinesController(tenant, reportingRepo, new MembershipsRepository());

  it('sets a manager, reads it back, and clears it', async () => {
    await tenant.transaction(northstarCtx, (tx) =>
      reportingRepo.set(tx, northstarCtx, {
        memberId: world.northstar.manager.membershipId,
        managerMemberId: world.northstar.designer.membershipId,
      }),
    );
    const read = await tenant.read(northstarCtx, (tx) =>
      reportingRepo.findByMember(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    expect(read?.managerMemberId).toBe(world.northstar.designer.membershipId);

    await tenant.transaction(northstarCtx, (tx) =>
      reportingRepo.clear(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    const cleared = await tenant.read(northstarCtx, (tx) =>
      reportingRepo.findByMember(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    expect(cleared).toBeNull();
  });

  it('refuses a self-reporting line at the engine CHECK', async () => {
    await expect(
      db.admin.execute(
        `insert into member_reporting_lines (id, organization_id, member_id, manager_member_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(),
          world.northstar.organizationId,
          world.northstar.manager.membershipId,
          world.northstar.manager.membershipId,
          new Date(),
          new Date(),
        ],
      ),
    ).rejects.toThrow(/ck_member_reporting_lines_not_self|[Cc]heck constraint/);
  });

  it('refuses a self-manager at the controller (400)', async () => {
    await expectApiError(
      controller().set(northstarCtx, owner, world.northstar.owner.membershipId, {
        managerMembershipId: world.northstar.owner.membershipId,
      }),
      400,
    );
  });

  it('refuses a longer cycle A→B→C→A at the controller (400)', async () => {
    const maya = world.northstar.owner.membershipId;
    const omar = world.northstar.manager.membershipId;
    const lina = world.northstar.designer.membershipId;

    // omar → lina, lina → maya. Both legal.
    await controller().set(northstarCtx, owner, omar, { managerMembershipId: lina });
    await controller().set(northstarCtx, owner, lina, { managerMembershipId: maya });

    // maya → omar would close the loop maya→omar→lina→maya.
    const error = await expectApiError(
      controller().set(northstarCtx, owner, maya, { managerMembershipId: omar }),
      400,
    );
    expect(error.message).toMatch(/cycle/i);

    // No edge was written for maya.
    const mayaLine = await tenant.read(northstarCtx, (tx) =>
      reportingRepo.findByMember(tx, northstarCtx, maya),
    );
    expect(mayaLine).toBeNull();
  });

  it('refuses a cross-tenant member or manager at the controller (404)', async () => {
    // The twin member is not visible under Northstar.
    await expectApiError(
      controller().set(northstarCtx, owner, world.twin.owner.membershipId, {
        managerMembershipId: world.northstar.manager.membershipId,
      }),
      404,
    );
    // A twin manager for a real Northstar member is equally not found.
    await expectApiError(
      controller().set(northstarCtx, owner, world.northstar.designer.membershipId, {
        managerMembershipId: world.twin.owner.membershipId,
      }),
      404,
    );
  });
});

describe('member_availability — windows persist, order, isolation, immutability', () => {
  it('creates windows that round-trip exactly and list in start-date order', async () => {
    const first = await tenant.transaction(northstarCtx, (tx) =>
      availabilityRepo.create(tx, northstarCtx, {
        memberId: world.northstar.manager.membershipId,
        startDate: '2026-03-10',
        endDate: '2026-03-14',
        kind: 'vacation',
        note: 'Spring break',
      }),
    );
    expect(first.startDate).toBe('2026-03-10');
    expect(first.endDate).toBe('2026-03-14');
    expect(first.kind).toBe('vacation');

    await tenant.transaction(northstarCtx, (tx) =>
      availabilityRepo.create(tx, northstarCtx, {
        memberId: world.northstar.manager.membershipId,
        startDate: '2026-01-05',
        endDate: '2026-01-05',
        kind: 'sick',
        note: null,
      }),
    );

    const list = await tenant.read(northstarCtx, (tx) =>
      availabilityRepo.listForMember(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    // Ordered by start_date ascending: the January window precedes the March one.
    expect(list.map((w) => w.startDate)).toEqual(['2026-01-05', '2026-03-10']);
    expect(list[0]?.endDate).toBe('2026-01-05');
    expect(list[1]?.note).toBe('Spring break');

    const removed = await tenant.transaction(northstarCtx, (tx) =>
      availabilityRepo.deleteOwn(tx, northstarCtx, world.northstar.manager.membershipId, first.id),
    );
    expect(removed).toBe(true);
    const afterDelete = await tenant.read(northstarCtx, (tx) =>
      availabilityRepo.listForMember(tx, northstarCtx, world.northstar.manager.membershipId),
    );
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]?.kind).toBe('sick');
  });

  it('holds a stored window immutable at the engine', async () => {
    const rows = await observe(
      `select id from member_availability where organization_id = ? and member_id = ? limit 1`,
      [world.northstar.organizationId, world.northstar.manager.membershipId],
    );
    const id = String(rows[0]?.['id']);
    await expect(
      db.admin.execute(`update member_availability set end_date = '2026-12-31' where id = ?`, [id]),
    ).rejects.toThrow(/immutable/);
  });

  it('never reads the twin windows and refuses a cross-tenant window write', async () => {
    await tenant.transaction(twinCtx, (tx) =>
      availabilityRepo.create(tx, twinCtx, {
        memberId: world.twin.owner.membershipId,
        startDate: '2026-02-01',
        endDate: '2026-02-05',
        kind: 'personal',
        note: null,
      }),
    );
    const leaked = await tenant.read(northstarCtx, (tx) =>
      availabilityRepo.listForMember(tx, northstarCtx, world.twin.owner.membershipId),
    );
    expect(leaked).toHaveLength(0);

    await expect(
      tenant.transaction(northstarCtx, (tx) =>
        availabilityRepo.create(tx, northstarCtx, {
          memberId: world.twin.owner.membershipId,
          startDate: '2026-02-01',
          endDate: '2026-02-05',
          kind: 'vacation',
          note: null,
        }),
      ),
    ).rejects.toThrow(/foreign key constraint fails/i);
  });
});
