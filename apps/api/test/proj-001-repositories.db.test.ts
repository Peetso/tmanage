import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilitiesFor, uuidv7, workItemStateMachine } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import {
  ClientOrganizationNotFoundError,
  ClientOrganizationVersionConflictError,
  ClientOrganizationsRepository,
} from '../src/modules/clients/client-organizations.repository.js';
import {
  ClientMembershipNotFoundError,
  ClientMembershipTransitionError,
  ClientMembershipVersionConflictError,
  ClientMembershipsRepository,
  isActiveNow,
} from '../src/modules/clients/client-memberships.repository.js';
import {
  ProjectMembershipConflictError,
  ProjectMembershipNotFoundError,
  ProjectMembershipsRepository,
} from '../src/modules/projects/project-memberships.repository.js';
import {
  WorkItemNotFoundError,
  WorkItemTransitionError,
  WorkItemVersionConflictError,
  WorkItemsRepository,
} from '../src/modules/work/work-items.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * PROJ-001's remaining repositories, against a real server and the adversarial tenant pair.
 *
 * One file rather than four. `vitest.config.ts` sets `fileParallelism: false` and each
 * database file starts its own embedded MySQL, so a fourth file would cost roughly a further
 * minute of wall clock to prove nothing a shared world cannot. The trade is that the suites
 * share seeded rows, so every assertion here is written to be order-independent:
 * `arrayContaining` rather than `toEqual` on lists, and rows created by the case that needs
 * them rather than mutated in place from the seed.
 *
 * Four questions are asked of every repository, because they are the four `ProjectsRepository`
 * had to answer and the reason its shape is copied rather than reinvented:
 *
 * 1. Is every read scoped to the acting tenant, including the near-identical twin?
 * 2. Does the tenant come from the `TenantContext` and nowhere else — in particular, is there
 *    no input field a request body could populate?
 * 3. Does a concurrent write lose rather than silently win?
 * 4. Does a caller in the wrong tenant get *not-found* rather than a conflict, which would
 *    confirm the row exists?
 *
 * Then the domain-specific half, which is where these four differ from projects and from each
 * other: client-membership expiry and the terminal `offboarded` status; project-membership
 * compare-and-swap and its real `DELETE`; the work-item state machine and soft deletion as a
 * different thing from the `archived` state.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let twin: TenantContext;

const clientOrgs = new ClientOrganizationsRepository();
const clientMembers = new ClientMembershipsRepository();
const projectMembers = new ProjectMembershipsRepository();
const work = new WorkItemsRepository();

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

/**
 * Advance the clock past the current millisecond.
 *
 * `updated_at` is `DATETIME(3)`, so an optimistic-concurrency token is only distinguishable
 * from its successor if at least a millisecond separates the two writes. Without this, a
 * stale-write case would pass or fail depending on how fast the machine happened to be —
 * which is a worse outcome than either. Where the table has a real `version` column
 * (`work_items`) no such wait is needed, and none is used.
 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** A fresh person. Client contacts and project members both need one nobody else holds. */
const newUser = async (email: string, displayName: string): Promise<string> => {
  const id = uuidv7();
  await db.admin.execute(
    `insert into users (id, email, display_name, email_verified_at)
     values (?, ?, ?, now(3))`,
    [id, email, displayName],
  );
  return id;
};

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
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
// Client organizations
// ─────────────────────────────────────────────────────────────────────────────

describe('client organizations', () => {
  it('lists only the acting tenant’s clients', async () => {
    const mine = await tenant.read(northstar, (tx) => clientOrgs.list(tx, northstar));
    const theirs = await tenant.read(twin, (tx) => clientOrgs.list(tx, twin));

    expect(mine.map((row) => row.id)).toEqual(
      expect.arrayContaining([
        world.atlas.clientOrganizationId,
        world.meridian.clientOrganizationId,
      ]),
    );
    expect(mine.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
    // The twin has no clients at all. A statement that lost its predicate would show it two.
    expect(theirs).toEqual([]);
  });

  it('returns null for a direct-id lookup from the wrong tenant', async () => {
    const found = await tenant.read(twin, (tx) =>
      clientOrgs.findById(tx, twin, world.atlas.clientOrganizationId),
    );
    expect(found).toBeNull();

    const reallyExists = await tenant.read(northstar, (tx) =>
      clientOrgs.findById(tx, northstar, world.atlas.clientOrganizationId),
    );
    expect(reallyExists?.name).toBe('Atlas Hospitality');
  });

  it('throws a not-found that does not name the other tenant', async () => {
    const error = await tenant
      .read(twin, (tx) => clientOrgs.requireById(tx, twin, world.atlas.clientOrganizationId))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientOrganizationNotFoundError);
    expect((error as Error).message).not.toContain(northstar.organizationId);
  });

  it('creates in the acting tenant and cannot be told which tenant to write into', async () => {
    const created = await tenant.transaction(northstar, async (tx) => {
      const row = await clientOrgs.create(tx, northstar, {
        name: 'Harbourline Freight',
        // @ts-expect-error organizationId is derived from TenantContext, never from input
        organizationId: twin.organizationId,
      });
      return row;
    });

    expect(created.organizationId).toBe(northstar.organizationId);
    expect(created.archivedAt).toBeNull();

    const inTwin = await tenant.read(twin, (tx) => clientOrgs.findById(tx, twin, created.id));
    expect(inTwin).toBeNull();
  });

  it('excludes archived clients unless asked', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      clientOrgs.create(tx, northstar, { name: 'Cedarbrook Estates' }),
    );
    await tenant.transaction(northstar, (tx) => clientOrgs.archive(tx, northstar, created.id));

    const visible = await tenant.read(northstar, (tx) =>
      clientOrgs.list(tx, northstar, { limit: 200 }),
    );
    const all = await tenant.read(northstar, (tx) =>
      clientOrgs.list(tx, northstar, { includeArchived: true, limit: 200 }),
    );

    expect(visible.map((row) => row.id)).not.toContain(created.id);
    expect(all.map((row) => row.id)).toContain(created.id);
  });

  it('paginates by keyset without repeating or skipping a row', async () => {
    const all = await tenant.read(northstar, (tx) =>
      clientOrgs.list(tx, northstar, { includeArchived: true, limit: 200 }),
    );
    expect(all.length).toBeGreaterThan(1);

    const firstPage = await tenant.read(northstar, (tx) =>
      clientOrgs.list(tx, northstar, { includeArchived: true, limit: 1 }),
    );
    const secondPage = await tenant.read(northstar, (tx) =>
      clientOrgs.list(tx, northstar, {
        includeArchived: true,
        limit: 1,
        after: firstPage[0]?.id as string,
      }),
    );

    expect(firstPage[0]?.id).toBe(all[0]?.id);
    expect(secondPage[0]?.id).toBe(all[1]?.id);
    expect(secondPage[0]?.id).not.toBe(firstPage[0]?.id);
  });

  it('refuses a stale write', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      clientOrgs.create(tx, northstar, { name: 'Vellum Publishing' }),
    );
    await tick();

    await tenant.transaction(northstar, (tx) =>
      clientOrgs.update(tx, northstar, created.id, created.updatedAt, {
        name: 'Vellum Publishing Group',
      }),
    );

    await expect(
      tenant.transaction(northstar, (tx) =>
        clientOrgs.update(tx, northstar, created.id, created.updatedAt, { name: 'Second writer' }),
      ),
    ).rejects.toThrow(ClientOrganizationVersionConflictError);

    const current = await tenant.read(northstar, (tx) =>
      clientOrgs.requireById(tx, northstar, created.id),
    );
    expect(current.name).toBe('Vellum Publishing Group');
  });

  it('reports not-found rather than conflict when the caller is in the wrong tenant', async () => {
    const atlas = await tenant.read(northstar, (tx) =>
      clientOrgs.requireById(tx, northstar, world.atlas.clientOrganizationId),
    );

    const error = await tenant
      .transaction(twin, (tx) =>
        clientOrgs.update(tx, twin, atlas.id, atlas.updatedAt, { name: 'Reaching across' }),
      )
      .catch((caught: unknown) => caught);

    // A conflict would confirm the row exists. Not-found discloses nothing.
    expect(error).toBeInstanceOf(ClientOrganizationNotFoundError);
    const untouched = await tenant.read(northstar, (tx) =>
      clientOrgs.requireById(tx, northstar, atlas.id),
    );
    expect(untouched.name).toBe('Atlas Hospitality');
  });

  it('archiving twice is not an error', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      clientOrgs.create(tx, northstar, { name: 'Two Rivers Hotels' }),
    );
    const once = await tenant.transaction(northstar, (tx) =>
      clientOrgs.archive(tx, northstar, created.id),
    );
    const twice = await tenant.transaction(northstar, (tx) =>
      clientOrgs.archive(tx, northstar, created.id),
    );

    expect(once.archivedAt).not.toBeNull();
    expect(twice.archivedAt?.getTime()).toBe(once.archivedAt?.getTime());
  });

  it('archiving a client does not revoke its members’ access', async () => {
    // The repository documents this as a deliberate non-cascade: ending a client relationship
    // is two acts, and the second one is a status change per named person. If archiving ever
    // starts implying offboarding, this case fails and the audit trail has quietly lost the
    // per-person revocations spec §12 requires.
    const clientOrg = await tenant.transaction(northstar, (tx) =>
      clientOrgs.create(tx, northstar, { name: 'Larkfield Wines' }),
    );
    const userId = await newUser('nadia.fahmy@larkfield.example', 'Nadia Fahmy');

    const invited = await tenant.transaction(northstar, (tx) =>
      clientMembers.invite(tx, northstar, {
        clientOrganizationId: clientOrg.id,
        userId,
        role: 'client_reviewer',
        expiresAt: null,
      }),
    );
    const active = await tenant.transaction(northstar, (tx) =>
      clientMembers.transitionStatus(tx, northstar, invited.id, invited.updatedAt, 'active'),
    );

    await tenant.transaction(northstar, (tx) => clientOrgs.archive(tx, northstar, clientOrg.id));

    const stillThere = await tenant.read(northstar, (tx) =>
      clientMembers.requireById(tx, northstar, active.id),
    );
    expect(stillThere.status).toBe('active');
    expect(isActiveNow(stillThere)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client memberships
// ─────────────────────────────────────────────────────────────────────────────

describe('client memberships', () => {
  it('lists only the acting tenant’s client members', async () => {
    const mine = await tenant.read(northstar, (tx) =>
      clientMembers.list(tx, northstar, { limit: 200 }),
    );
    const theirs = await tenant.read(twin, (tx) => clientMembers.list(tx, twin, { limit: 200 }));

    expect(mine.map((row) => row.userId)).toEqual(
      expect.arrayContaining([
        world.atlas.admin.id,
        world.atlas.reviewer.id,
        world.atlas.viewer.id,
        world.meridian.reviewer.id,
      ]),
    );
    expect(theirs).toEqual([]);
  });

  it('scopes to one client organization when asked', async () => {
    const atlasOnly = await tenant.read(northstar, (tx) =>
      clientMembers.list(tx, northstar, {
        clientOrganizationId: world.atlas.clientOrganizationId,
        limit: 200,
      }),
    );

    // Meridian is a client of the *same* tenant, so this boundary is the one no tenant
    // predicate can enforce for you.
    expect(atlasOnly.map((row) => row.userId)).toContain(world.atlas.reviewer.id);
    expect(atlasOnly.map((row) => row.userId)).not.toContain(world.meridian.reviewer.id);
  });

  it('an invitation authorises nothing until it is accepted', async () => {
    const userId = await newUser('rami.selim@atlas.example', 'Rami Selim');
    const invited = await tenant.transaction(northstar, (tx) =>
      clientMembers.invite(tx, northstar, {
        clientOrganizationId: world.atlas.clientOrganizationId,
        userId,
        role: 'client_viewer',
        expiresAt: null,
      }),
    );

    expect(invited.status).toBe('invited');
    expect(isActiveNow(invited)).toBe(false);

    const listed = await tenant.read(northstar, (tx) =>
      clientMembers.list(tx, northstar, { limit: 200 }),
    );
    expect(listed.map((row) => row.id)).not.toContain(invited.id);

    const opted = await tenant.read(northstar, (tx) =>
      clientMembers.list(tx, northstar, { statuses: ['invited'], limit: 200 }),
    );
    expect(opted.map((row) => row.id)).toContain(invited.id);
  });

  it('refuses a second invitation for the same person in the same client', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        clientMembers.invite(tx, northstar, {
          clientOrganizationId: world.atlas.clientOrganizationId,
          userId: world.atlas.reviewer.id,
          role: 'client_viewer',
          expiresAt: null,
        }),
      ),
    ).rejects.toThrow(/duplicate/i);
  });

  it('refuses a client organization belonging to another tenant, at the storage layer', async () => {
    // No service-layer check is involved. fk_client_memberships_client_org_tenant is a
    // composite foreign key including organization_id, so the pair (twin, Northstar's client)
    // does not exist even though both ids individually do.
    const userId = await newUser('kareem.wahba@atlas.example', 'Kareem Wahba');
    await expect(
      tenant.transaction(twin, (tx) =>
        clientMembers.invite(tx, twin, {
          clientOrganizationId: world.atlas.clientOrganizationId,
          userId,
          role: 'client_viewer',
          expiresAt: null,
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('excludes an expired grant, and the database is what decides it', async () => {
    const userId = await newUser('sara.mansour@atlas.example', 'Sara Mansour');
    const invited = await tenant.transaction(northstar, (tx) =>
      clientMembers.invite(tx, northstar, {
        clientOrganizationId: world.atlas.clientOrganizationId,
        userId,
        role: 'client_reviewer',
        expiresAt: null,
      }),
    );
    await tick();
    const active = await tenant.transaction(northstar, (tx) =>
      clientMembers.transitionStatus(tx, northstar, invited.id, invited.updatedAt, 'active'),
    );
    await tick();

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const expired = await tenant.transaction(northstar, (tx) =>
      clientMembers.setExpiry(tx, northstar, active.id, active.updatedAt, yesterday),
    );

    // Still `active` as a status. That is the whole point: status alone is the wrong question.
    expect(expired.status).toBe('active');
    expect(isActiveNow(expired)).toBe(false);

    const live = await tenant.read(northstar, (tx) =>
      clientMembers.list(tx, northstar, { limit: 200 }),
    );
    const withExpired = await tenant.read(northstar, (tx) =>
      clientMembers.list(tx, northstar, { includeExpired: true, limit: 200 }),
    );

    expect(live.map((row) => row.id)).not.toContain(expired.id);
    expect(withExpired.map((row) => row.id)).toContain(expired.id);
  });

  it('an open-ended grant is a decision, and restores access when made', async () => {
    const userId = await newUser('tamer.gaber@atlas.example', 'Tamer Gaber');
    const invited = await tenant.transaction(northstar, (tx) =>
      clientMembers.invite(tx, northstar, {
        clientOrganizationId: world.atlas.clientOrganizationId,
        userId,
        role: 'client_reviewer',
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );
    await tick();
    const active = await tenant.transaction(northstar, (tx) =>
      clientMembers.transitionStatus(tx, northstar, invited.id, invited.updatedAt, 'active'),
    );
    await tick();

    const before = await tenant.read(northstar, (tx) =>
      clientMembers.list(tx, northstar, { limit: 200 }),
    );
    expect(before.map((row) => row.id)).not.toContain(active.id);

    const openEnded = await tenant.transaction(northstar, (tx) =>
      clientMembers.setExpiry(tx, northstar, active.id, active.updatedAt, null),
    );
    expect(openEnded.expiresAt).toBeNull();

    const after = await tenant.read(northstar, (tx) =>
      clientMembers.list(tx, northstar, { limit: 200 }),
    );
    expect(after.map((row) => row.id)).toContain(active.id);
  });

  it('offboarded is terminal — nothing readmits a client contact', async () => {
    const userId = await newUser('hoda.nabil@atlas.example', 'Hoda Nabil');
    const invited = await tenant.transaction(northstar, (tx) =>
      clientMembers.invite(tx, northstar, {
        clientOrganizationId: world.atlas.clientOrganizationId,
        userId,
        role: 'client_viewer',
        expiresAt: null,
      }),
    );
    await tick();
    const offboarded = await tenant.transaction(northstar, (tx) =>
      clientMembers.transitionStatus(tx, northstar, invited.id, invited.updatedAt, 'offboarded'),
    );
    await tick();

    const error = await tenant
      .transaction(northstar, (tx) =>
        clientMembers.transitionStatus(
          tx,
          northstar,
          offboarded.id,
          offboarded.updatedAt,
          'active',
        ),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientMembershipTransitionError);
    expect((error as ClientMembershipTransitionError).from).toBe('offboarded');
    expect((error as ClientMembershipTransitionError).to).toBe('active');

    const current = await tenant.read(northstar, (tx) =>
      clientMembers.requireById(tx, northstar, offboarded.id),
    );
    expect(current.status).toBe('offboarded');
  });

  it('refuses a stale role change', async () => {
    const userId = await newUser('yara.helmy@atlas.example', 'Yara Helmy');
    const invited = await tenant.transaction(northstar, (tx) =>
      clientMembers.invite(tx, northstar, {
        clientOrganizationId: world.atlas.clientOrganizationId,
        userId,
        role: 'client_viewer',
        expiresAt: null,
      }),
    );
    await tick();

    await tenant.transaction(northstar, (tx) =>
      clientMembers.changeRole(tx, northstar, invited.id, invited.updatedAt, 'client_reviewer'),
    );

    await expect(
      tenant.transaction(northstar, (tx) =>
        clientMembers.changeRole(tx, northstar, invited.id, invited.updatedAt, 'client_admin'),
      ),
    ).rejects.toThrow(ClientMembershipVersionConflictError);

    const current = await tenant.read(northstar, (tx) =>
      clientMembers.requireById(tx, northstar, invited.id),
    );
    expect(current.role).toBe('client_reviewer');
  });

  it('reports not-found rather than conflict when the caller is in the wrong tenant', async () => {
    const atlasReviewer = await tenant.read(northstar, (tx) =>
      clientMembers.requireById(tx, northstar, world.atlas.reviewer.membershipId),
    );

    const error = await tenant
      .transaction(twin, (tx) =>
        clientMembers.changeRole(
          tx,
          twin,
          atlasReviewer.id,
          atlasReviewer.updatedAt,
          'client_admin',
        ),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClientMembershipNotFoundError);
    const untouched = await tenant.read(northstar, (tx) =>
      clientMembers.requireById(tx, northstar, atlasReviewer.id),
    );
    expect(untouched.role).toBe('client_reviewer');
  });

  it('finds a member by client organization and user, only within the tenant', async () => {
    const mine = await tenant.read(northstar, (tx) =>
      clientMembers.findByUser(
        tx,
        northstar,
        world.atlas.clientOrganizationId,
        world.atlas.reviewer.id,
      ),
    );
    const fromTwin = await tenant.read(twin, (tx) =>
      clientMembers.findByUser(tx, twin, world.atlas.clientOrganizationId, world.atlas.reviewer.id),
    );

    expect(mine?.id).toBe(world.atlas.reviewer.membershipId);
    expect(fromTwin).toBeNull();
  });

  it('cannot be told which tenant to write into', async () => {
    const userId = await newUser('bassem.zaki@atlas.example', 'Bassem Zaki');
    await tenant.transaction(northstar, async (tx) => {
      const created = await clientMembers.invite(tx, northstar, {
        clientOrganizationId: world.atlas.clientOrganizationId,
        userId,
        role: 'client_viewer',
        expiresAt: null,
        // @ts-expect-error organizationId is derived from TenantContext, never from input
        organizationId: twin.organizationId,
      });
      expect(created.organizationId).toBe(northstar.organizationId);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Project memberships
// ─────────────────────────────────────────────────────────────────────────────

describe('project memberships', () => {
  it('lists one project’s members, and nothing from the twin’s identically named project', async () => {
    const mine = await tenant.read(northstar, (tx) =>
      projectMembers.listByProject(tx, northstar, world.northstar.projectId, { limit: 200 }),
    );
    const reachingAcross = await tenant.read(northstar, (tx) =>
      projectMembers.listByProject(tx, northstar, world.twin.projectId, { limit: 200 }),
    );

    expect(mine.map((row) => row.userId)).toEqual(
      expect.arrayContaining([world.northstar.manager.id, world.northstar.designer.id]),
    );
    expect(mine.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
    expect(reachingAcross).toEqual([]);
  });

  it('lists one person’s projects through a join anchored on the tenant on both sides', async () => {
    const omar = await tenant.read(northstar, (tx) =>
      projectMembers.listByUser(tx, northstar, world.northstar.manager.id, { limit: 200 }),
    );
    const lina = await tenant.read(northstar, (tx) =>
      projectMembers.listByUser(tx, northstar, world.northstar.designer.id, { limit: 200 }),
    );

    // Omar is on both Northstar projects; Lina is deliberately on only one of them — the
    // same-tenant, different-project case from spec §11.
    expect(omar.map((row) => row.projectId)).toEqual(
      expect.arrayContaining([world.northstar.projectId, world.northstar.otherProjectId]),
    );
    expect(lina.map((row) => row.projectId)).toEqual([world.northstar.projectId]);

    const fromTwin = await tenant.read(twin, (tx) =>
      projectMembers.listByUser(tx, twin, world.northstar.manager.id, { limit: 200 }),
    );
    expect(fromTwin).toEqual([]);
  });

  it('adds in the acting tenant and cannot be told which tenant to write into', async () => {
    const userId = await newUser('farida.gamal@northstar.example', 'Farida Gamal');
    const created = await tenant.transaction(northstar, async (tx) =>
      projectMembers.add(tx, northstar, {
        projectId: world.northstar.otherProjectId,
        userId,
        role: 'member',
        // @ts-expect-error organizationId is derived from TenantContext, never from input
        organizationId: twin.organizationId,
      }),
    );

    expect(created.organizationId).toBe(northstar.organizationId);
    expect(created.createdAt).toBeInstanceOf(Date);

    const inTwin = await tenant.read(twin, (tx) => projectMembers.findById(tx, twin, created.id));
    expect(inTwin).toBeNull();
  });

  it('refuses a project belonging to another tenant, at the storage layer', async () => {
    const userId = await newUser('nour.adly@northstar.example', 'Nour Adly');
    await expect(
      tenant.transaction(northstar, (tx) =>
        projectMembers.add(tx, northstar, {
          projectId: world.twin.projectId,
          userId,
          role: 'member',
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('refuses a second membership for the same person on the same project', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        projectMembers.add(tx, northstar, {
          projectId: world.northstar.projectId,
          userId: world.northstar.designer.id,
          role: 'member',
        }),
      ),
    ).rejects.toThrow(/duplicate/i);
  });

  it('refuses a role change that raced another', async () => {
    const userId = await newUser('ziad.sherif@northstar.example', 'Ziad Sherif');
    const created = await tenant.transaction(northstar, (tx) =>
      projectMembers.add(tx, northstar, {
        projectId: world.northstar.projectId,
        userId,
        role: 'member',
      }),
    );

    const promoted = await tenant.transaction(northstar, (tx) =>
      projectMembers.changeRole(tx, northstar, created.id, 'member', 'manager'),
    );
    expect(promoted.role).toBe('manager');

    // The second writer still believes the role is `member`. Its intent must not disappear
    // silently — see the note on the repository about what a role-as-token does and does not
    // buy compared with a version column.
    const error = await tenant
      .transaction(northstar, (tx) =>
        projectMembers.changeRole(tx, northstar, created.id, 'member', 'moderator'),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectMembershipConflictError);
    expect((error as ProjectMembershipConflictError).actualRole).toBe('manager');

    const current = await tenant.read(northstar, (tx) =>
      projectMembers.requireById(tx, northstar, created.id),
    );
    expect(current.role).toBe('manager');
  });

  it('treats a role change that is already applied as success, not conflict', async () => {
    const userId = await newUser('mona.fouad@northstar.example', 'Mona Fouad');
    const created = await tenant.transaction(northstar, (tx) =>
      projectMembers.add(tx, northstar, {
        projectId: world.northstar.projectId,
        userId,
        role: 'manager',
      }),
    );

    // MySQL reports zero affected rows for a write that changes nothing, which the naive
    // reading would turn into a conflict for a retried request that already succeeded.
    const again = await tenant.transaction(northstar, (tx) =>
      projectMembers.changeRole(tx, northstar, created.id, 'manager', 'manager'),
    );
    expect(again.role).toBe('manager');
  });

  it('reports not-found rather than conflict when the caller is in the wrong tenant', async () => {
    const theirs = await tenant.read(twin, (tx) =>
      projectMembers.listByProject(tx, twin, world.twin.projectId, { limit: 200 }),
    );
    const target = theirs[0];
    expect(target).toBeDefined();

    const error = await tenant
      .transaction(northstar, (tx) =>
        projectMembers.changeRole(tx, northstar, target?.id as string, 'member', 'owner'),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectMembershipNotFoundError);
    expect((error as Error).message).not.toContain(twin.organizationId);
  });

  it('removes a membership, idempotently', async () => {
    const userId = await newUser('adham.sabry@northstar.example', 'Adham Sabry');
    const created = await tenant.transaction(northstar, (tx) =>
      projectMembers.add(tx, northstar, {
        projectId: world.northstar.projectId,
        userId,
        role: 'member',
      }),
    );

    const first = await tenant.transaction(northstar, (tx) =>
      projectMembers.remove(tx, northstar, created.id),
    );
    const second = await tenant.transaction(northstar, (tx) =>
      projectMembers.remove(tx, northstar, created.id),
    );

    // The boolean is what an audit-writing command needs: the first call revoked something,
    // the second was a retry that revoked nothing.
    expect(first).toBe(true);
    expect(second).toBe(false);

    const gone = await tenant.read(northstar, (tx) =>
      projectMembers.findById(tx, northstar, created.id),
    );
    expect(gone).toBeNull();
  });

  it('cannot delete another tenant’s membership', async () => {
    const theirs = await tenant.read(twin, (tx) =>
      projectMembers.listByProject(tx, twin, world.twin.projectId, { limit: 200 }),
    );
    const target = theirs[0];
    expect(target).toBeDefined();

    const removed = await tenant.transaction(northstar, (tx) =>
      projectMembers.remove(tx, northstar, target?.id as string),
    );
    expect(removed).toBe(false);

    const stillThere = await tenant.read(twin, (tx) =>
      projectMembers.findById(tx, twin, target?.id as string),
    );
    expect(stillThere?.id).toBe(target?.id);
  });

  it('paginates by keyset without repeating or skipping a row', async () => {
    const all = await tenant.read(northstar, (tx) =>
      projectMembers.listByProject(tx, northstar, world.northstar.projectId, { limit: 200 }),
    );
    expect(all.length).toBeGreaterThan(1);

    const firstPage = await tenant.read(northstar, (tx) =>
      projectMembers.listByProject(tx, northstar, world.northstar.projectId, { limit: 1 }),
    );
    const secondPage = await tenant.read(northstar, (tx) =>
      projectMembers.listByProject(tx, northstar, world.northstar.projectId, {
        limit: 1,
        after: firstPage[0]?.id as string,
      }),
    );

    expect(firstPage[0]?.id).toBe(all[0]?.id);
    expect(secondPage[0]?.id).toBe(all[1]?.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Work items
// ─────────────────────────────────────────────────────────────────────────────

describe('work items', () => {
  const create = (title: string, audience?: 'internal' | 'client_visible') =>
    tenant.transaction(northstar, (tx) =>
      work.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title,
        ...(audience ? { audience } : {}),
      }),
    );

  it('lists only the acting tenant’s work, despite identical titles', async () => {
    const mine = await tenant.read(northstar, (tx) => work.list(tx, northstar, { limit: 200 }));
    const theirs = await tenant.read(twin, (tx) => work.list(tx, twin, { limit: 200 }));

    // Both tenants hold an item called "Prepare mobile booking flow concepts". A lookup that
    // matched on title rather than on (organization_id, id) would resolve to the wrong one.
    expect(mine.map((row) => row.id)).toContain(world.northstar.workItemId);
    expect(mine.map((row) => row.id)).not.toContain(world.twin.workItemId);
    expect(theirs.map((row) => row.id)).toEqual([world.twin.workItemId]);
  });

  it('returns null for a direct-id lookup from the wrong tenant', async () => {
    const found = await tenant.read(northstar, (tx) =>
      work.findById(tx, northstar, world.twin.workItemId),
    );
    expect(found).toBeNull();

    const error = await tenant
      .read(northstar, (tx) => work.requireById(tx, northstar, world.twin.workItemId))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkItemNotFoundError);
    expect((error as Error).message).not.toContain(twin.organizationId);
  });

  it('creates at the lifecycle’s initial state, not the column default', async () => {
    const created = await create('Draft the loyalty tier comparison');

    // `work_items.state` defaults to 'triage' in 0001_tenancy.sql, which is a client-request
    // state and not a work-item state at all (23-ERD §5 vs §7). The repository writes the
    // state explicitly so nothing depends on that default; the defect itself is recorded in
    // docs/implementation-status.md, because correcting it is a migration.
    expect(created.state).toBe(workItemStateMachine.definition.initial);
    expect(created.state).toBe('backlog');
    expect(created.audience).toBe('internal');
    expect(created.version).toBe(1);
    expect(created.deletedAt).toBeNull();
  });

  it('cannot be told which tenant to write into, and has no state field to be told either', async () => {
    await tenant.transaction(northstar, async (tx) => {
      const created = await work.create(tx, northstar, {
        projectId: world.northstar.projectId,
        title: 'Payload cannot choose the tenant',
        // @ts-expect-error organizationId is derived from TenantContext, never from input
        organizationId: twin.organizationId,
      });
      expect(created.organizationId).toBe(northstar.organizationId);

      await work.update(tx, northstar, created.id, created.version, {
        title: 'Payload cannot choose the state',
        // @ts-expect-error state moves through transitionState, never by assignment
        state: 'done',
      });
    });
  });

  it('refuses a project belonging to another tenant, at the storage layer', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        work.create(tx, northstar, {
          projectId: world.twin.projectId,
          title: 'Cross-tenant project',
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('filters by audience, and returns every audience when not asked', async () => {
    const internal = await create('Internal estimate review');
    const visible = await create('Share the revised timeline', 'client_visible');

    const clientProjection = await tenant.read(northstar, (tx) =>
      work.list(tx, northstar, { audiences: ['client_visible'], limit: 200 }),
    );
    const everything = await tenant.read(northstar, (tx) =>
      work.list(tx, northstar, { limit: 200 }),
    );

    expect(clientProjection.map((row) => row.id)).toContain(visible.id);
    expect(clientProjection.map((row) => row.id)).not.toContain(internal.id);
    // Omitting the allowlist is only ever correct for an internal reader — asserted here so
    // that the default is a deliberate, visible behaviour rather than an assumption.
    expect(everything.map((row) => row.id)).toEqual(
      expect.arrayContaining([internal.id, visible.id]),
    );
  });

  it('filters by state', async () => {
    const created = await create('Ready for pickup');
    const ready = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, created.id, created.version, 'ready'),
    );

    const inBacklog = await tenant.read(northstar, (tx) =>
      work.list(tx, northstar, { states: ['backlog'], limit: 200 }),
    );
    const inReady = await tenant.read(northstar, (tx) =>
      work.list(tx, northstar, { states: ['ready'], limit: 200 }),
    );

    expect(inReady.map((row) => row.id)).toContain(ready.id);
    expect(inBacklog.map((row) => row.id)).not.toContain(ready.id);
  });

  it('paginates by keyset without repeating or skipping a row', async () => {
    const all = await tenant.read(northstar, (tx) => work.list(tx, northstar, { limit: 200 }));
    expect(all.length).toBeGreaterThan(1);

    const firstPage = await tenant.read(northstar, (tx) => work.list(tx, northstar, { limit: 1 }));
    const secondPage = await tenant.read(northstar, (tx) =>
      work.list(tx, northstar, { limit: 1, after: firstPage[0]?.id as string }),
    );

    expect(firstPage[0]?.id).toBe(all[0]?.id);
    expect(secondPage[0]?.id).toBe(all[1]?.id);
  });

  it('refuses a stale update and advances the version on a fresh one', async () => {
    const created = await create('Concurrently edited');

    const updated = await tenant.transaction(northstar, (tx) =>
      work.update(tx, northstar, created.id, created.version, { title: 'First writer' }),
    );
    expect(updated.version).toBe(created.version + 1);

    await expect(
      tenant.transaction(northstar, (tx) =>
        work.update(tx, northstar, created.id, created.version, { title: 'Second writer' }),
      ),
    ).rejects.toThrow(WorkItemVersionConflictError);

    const current = await tenant.read(northstar, (tx) =>
      work.requireById(tx, northstar, created.id),
    );
    expect(current.title).toBe('First writer');
  });

  it('walks the lifecycle the state machine defines', async () => {
    const created = await create('Rebuild the booking confirmation email');

    const ready = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, created.id, created.version, 'ready'),
    );
    const started = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, ready.id, ready.version, 'in_progress'),
    );
    const inReview = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, started.id, started.version, 'internal_review'),
    );
    // Since 0013 the repository also takes the parsed completion — the columns `done` writes.
    // The service derives it from the facts; a direct caller supplies both.
    const whenDone = new Date();
    const done = await tenant.transaction(northstar, (tx) =>
      work.transitionState(
        tx,
        northstar,
        inReview.id,
        inReview.version,
        'done',
        { ownerId: world.northstar.designer.id, completedAt: whenDone },
        { ownerUserId: world.northstar.designer.id, completedAt: whenDone },
      ),
    );

    expect([ready.state, started.state, inReview.state, done.state]).toEqual([
      'ready',
      'in_progress',
      'internal_review',
      'done',
    ]);
    expect(done.version).toBe(created.version + 4);
  });

  it('refuses an illegal move', async () => {
    const created = await create('Cannot skip the middle');

    const error = await tenant
      .transaction(northstar, (tx) =>
        work.transitionState(tx, northstar, created.id, created.version, 'done', {
          ownerId: world.northstar.designer.id,
          completedAt: new Date(),
        }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkItemTransitionError);
    expect((error as WorkItemTransitionError).reason).toBe('illegal_transition');

    const current = await tenant.read(northstar, (tx) =>
      work.requireById(tx, northstar, created.id),
    );
    expect(current.state).toBe('backlog');
    expect(current.version).toBe(created.version);
  });

  it('names the facts a legal move was missing', async () => {
    const created = await create('Blocked on the client’s brand assets');
    const ready = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, created.id, created.version, 'ready'),
    );
    const started = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, ready.id, ready.version, 'in_progress'),
    );

    const error = await tenant
      .transaction(northstar, (tx) =>
        work.transitionState(tx, northstar, started.id, started.version, 'blocked'),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkItemTransitionError);
    expect((error as WorkItemTransitionError).reason).toBe('missing_requirement');
    expect((error as WorkItemTransitionError).missing).toEqual(
      expect.arrayContaining(['blockerReason', 'blockerAsk']),
    );

    // Supplied, the same move succeeds — and leaving `blocked` requires its own fact.
    const blocked = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, started.id, started.version, 'blocked', {
        blockerReason: 'Awaiting the approved logo pack',
        blockerAsk: 'Send the final brand assets',
      }),
    );
    expect(blocked.state).toBe('blocked');

    await expect(
      tenant.transaction(northstar, (tx) =>
        work.transitionState(tx, northstar, blocked.id, blocked.version, 'in_progress'),
      ),
    ).rejects.toThrow(WorkItemTransitionError);

    const resumed = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, blocked.id, blocked.version, 'in_progress', {
        blockerResolution: 'Assets received on 2026-08-24',
      }),
    );
    expect(resumed.state).toBe('in_progress');
  });

  it('refuses a transition that raced another, without changing the state', async () => {
    const created = await create('Two people move it at once');

    const ready = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, created.id, created.version, 'ready'),
    );

    // The second writer's check is made against a state the row has just stopped being in.
    await expect(
      tenant.transaction(northstar, (tx) =>
        work.transitionState(tx, northstar, created.id, created.version, 'in_progress'),
      ),
    ).rejects.toThrow(WorkItemVersionConflictError);

    const current = await tenant.read(northstar, (tx) =>
      work.requireById(tx, northstar, created.id),
    );
    expect(current.state).toBe('ready');
    expect(current.version).toBe(ready.version);
  });

  it('reports not-found rather than conflict when the caller is in the wrong tenant', async () => {
    const theirs = await tenant.read(twin, (tx) =>
      work.requireById(tx, twin, world.twin.workItemId),
    );

    const error = await tenant
      .transaction(northstar, (tx) =>
        work.update(tx, northstar, theirs.id, theirs.version, { title: 'Reaching across' }),
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkItemNotFoundError);
    const untouched = await tenant.read(twin, (tx) => work.requireById(tx, twin, theirs.id));
    expect(untouched.title).toBe(world.twin.workItemTitle);
    expect(untouched.version).toBe(theirs.version);
  });

  it('soft-deletes without touching the state, and deleting twice is not an error', async () => {
    const created = await create('Created by mistake');

    const deleted = await tenant.transaction(northstar, (tx) =>
      work.softDelete(tx, northstar, created.id),
    );
    const again = await tenant.transaction(northstar, (tx) =>
      work.softDelete(tx, northstar, created.id),
    );

    expect(deleted.deletedAt).not.toBeNull();
    expect(again.deletedAt?.getTime()).toBe(deleted.deletedAt?.getTime());
    // Deletion is not a lifecycle event. The item is still in whatever state it was in.
    expect(deleted.state).toBe('backlog');

    const visible = await tenant.read(northstar, (tx) => work.list(tx, northstar, { limit: 200 }));
    const all = await tenant.read(northstar, (tx) =>
      work.list(tx, northstar, { includeDeleted: true, limit: 200 }),
    );
    expect(visible.map((row) => row.id)).not.toContain(created.id);
    expect(all.map((row) => row.id)).toContain(created.id);
  });

  it('archiving is a lifecycle state, not a deletion', async () => {
    const created = await create('Abandoned before it started');
    const archived = await tenant.transaction(northstar, (tx) =>
      work.transitionState(tx, northstar, created.id, created.version, 'archived'),
    );

    expect(archived.state).toBe('archived');
    expect(archived.deletedAt).toBeNull();

    // Still listed. "We finished with this" and "this should never have existed" are different
    // facts, and collapsing them would make the first one disappear from every default read.
    const visible = await tenant.read(northstar, (tx) => work.list(tx, northstar, { limit: 200 }));
    expect(visible.map((row) => row.id)).toContain(created.id);
  });
});
