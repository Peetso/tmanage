import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import {
  ProjectNotFoundError,
  ProjectVersionConflictError,
  ProjectsRepository,
} from '../src/modules/projects/projects.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * The first scoped repository, against a real server and the adversarial tenant pair.
 *
 * Two distinct things are under test and it is worth keeping them apart:
 *
 * 1. **The repository does what §6 requires** — no unscoped read, the tenant comes from the
 *    context and not from the input, optimistic concurrency refuses a stale write.
 * 2. **Drizzle did not become an escape hatch.** This is the load-bearing one. `drizzle.ts`
 *    wires the ORM through the tenant guard rather than through the pool, and if that
 *    wiring were wrong every assertion in group 1 could still pass while ADR-0001 layer 3
 *    sat unused. So the guard is observed directly: a deliberately unscoped Drizzle query
 *    must still throw, and the event must still be emitted.
 *
 * The tenants are the same near-identical pair the isolation corpus uses — Northstar Studio
 * and Northstar Studios, ids differing in the final hex digit — because a repository test
 * against obviously distinct tenants passes whether or not the predicate is there.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let northstar: TenantContext;
let twin: TenantContext;
const repository = new ProjectsRepository();

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

describe('the Drizzle seam keeps the tenant guard on the path', () => {
  it('routes a Drizzle-built statement through the guard', async () => {
    // The positive control. If Drizzle held the pool this would still pass, which is why
    // the next two cases exist.
    const rows = await tenant.read(northstar, (tx) => repository.list(tx, northstar));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
  });

  it('throws when a Drizzle query omits the tenant predicate, and names the table', async () => {
    const before = guardEvents.length;
    await expect(
      tenant.read(northstar, async (tx) => {
        const { tenantDrizzle } = await import('../src/common/database/drizzle.js');
        const { projects } = await import('../src/common/database/schema.js');
        // Exactly the mistake the guard exists for, expressed in Drizzle rather than in
        // raw SQL. On MySQL this returns every tenant's projects.
        return tenantDrizzle(tx).select().from(projects);
      }),
    ).rejects.toThrow(/no organization_id predicate/);

    expect(guardEvents.length).toBe(before + 1);
    expect(guardEvents.at(-1)?.tenantTables).toEqual(['projects']);
    expect(guardEvents.at(-1)?.correlationId).toBe(northstar.correlationId);
  });

  it('and the omitted predicate would genuinely have leaked', async () => {
    // The rejection is only meaningful if the statement it rejected was dangerous. Replayed
    // on the admin connection: three organizations' projects, two sharing a name.
    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select organization_id as o, name as n from projects',
    );
    const organizations = new Set(rows.map((row) => String(row['o'])));
    expect(organizations.size).toBeGreaterThan(1);
    expect(organizations.has(twin.organizationId)).toBe(true);
  });
});

describe('reads are scoped', () => {
  it('lists only the acting tenant’s projects', async () => {
    const mine = await tenant.read(northstar, (tx) => repository.list(tx, northstar));
    const theirs = await tenant.read(twin, (tx) => repository.list(tx, twin));

    expect(mine.map((row) => row.id)).toContain(world.northstar.projectId);
    expect(mine.map((row) => row.id)).not.toContain(world.twin.projectId);
    expect(theirs.map((row) => row.id)).toContain(world.twin.projectId);
  });

  it('returns null for a direct-id lookup of the twin’s project', async () => {
    // The row exists, the id is correct, the caller is simply in the wrong tenant. Under
    // RLS this would return nothing for free; here the predicate is what does it.
    const found = await tenant.read(northstar, (tx) =>
      repository.findById(tx, northstar, world.twin.projectId),
    );
    expect(found).toBeNull();

    const reallyExists = await tenant.read(twin, (tx) =>
      repository.findById(tx, twin, world.twin.projectId),
    );
    expect(reallyExists?.id).toBe(world.twin.projectId);
  });

  it('throws a not-found that does not disclose the other tenant', async () => {
    const error = await tenant
      .read(northstar, (tx) => repository.requireById(tx, northstar, world.twin.projectId))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProjectNotFoundError);
    expect((error as Error).message).not.toContain(twin.organizationId);
  });

  it('excludes archived projects unless asked', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        workspaceId: world.northstar.workspaceId,
        name: 'Archived campaign',
      }),
    );
    await tenant.transaction(northstar, (tx) => repository.archive(tx, northstar, created.id));

    const visible = await tenant.read(northstar, (tx) => repository.list(tx, northstar));
    const all = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { includeArchived: true }),
    );

    expect(visible.map((row) => row.id)).not.toContain(created.id);
    expect(all.map((row) => row.id)).toContain(created.id);
  });

  it('paginates by keyset without repeating or skipping a row', async () => {
    const all = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { includeArchived: true, limit: 200 }),
    );
    const firstPage = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, { includeArchived: true, limit: 1 }),
    );
    const secondPage = await tenant.read(northstar, (tx) =>
      repository.list(tx, northstar, {
        includeArchived: true,
        limit: 1,
        after: firstPage[0]?.id as string,
      }),
    );

    expect(firstPage).toHaveLength(1);
    expect(firstPage[0]?.id).toBe(all[0]?.id);
    expect(secondPage[0]?.id).toBe(all[1]?.id);
    expect(secondPage[0]?.id).not.toBe(firstPage[0]?.id);
  });

  it('scopes a workspace join on both sides', async () => {
    const rows = await tenant.read(northstar, (tx) =>
      repository.listByWorkspace(tx, northstar, world.northstar.workspaceId),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
  });

  it('returns nothing when the workspace belongs to the twin', async () => {
    const rows = await tenant.read(northstar, (tx) =>
      repository.listByWorkspace(tx, northstar, world.twin.workspaceId),
    );
    expect(rows).toEqual([]);
  });
});

describe('writes take the tenant from the context', () => {
  it('creates in the acting tenant and leaves the twin untouched', async () => {
    const before = await tenant.read(twin, (tx) => repository.list(tx, twin));

    const created = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        workspaceId: world.northstar.workspaceId,
        name: 'Atlas Website Relaunch — phase 2',
      }),
    );

    expect(created.organizationId).toBe(northstar.organizationId);
    expect(created.createdAt).toBeInstanceOf(Date);

    const after = await tenant.read(twin, (tx) => repository.list(tx, twin));
    expect(after).toHaveLength(before.length);
  });

  it('cannot be told which tenant to write into', async () => {
    // Not a runtime assertion — a structural one. `CreateProjectInput` has no
    // `organizationId`, so this is a compile error rather than a leak, and the @ts-expect-error
    // fails the typecheck gate if the field is ever added.
    await tenant.transaction(northstar, async (tx) => {
      const created = await repository.create(tx, northstar, {
        workspaceId: world.northstar.workspaceId,
        name: 'Payload cannot choose the tenant',
        // @ts-expect-error organizationId is derived from TenantContext, never from input
        organizationId: twin.organizationId,
      });
      expect(created.organizationId).toBe(northstar.organizationId);
    });
  });

  it('refuses a workspace belonging to another tenant, at the storage layer', async () => {
    // No service-layer check is involved. fk_projects_workspace_tenant is a composite
    // foreign key including organization_id, so the pair (northstar, twin's workspace)
    // does not exist even though both ids individually do.
    await expect(
      tenant.transaction(northstar, (tx) =>
        repository.create(tx, northstar, {
          workspaceId: world.twin.workspaceId,
          name: 'Cross-tenant workspace',
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('rolls back the whole unit of work when a later statement fails', async () => {
    const before = await tenant.read(northstar, (tx) => repository.list(tx, northstar));

    await expect(
      tenant.transaction(northstar, async (tx) => {
        await repository.create(tx, northstar, {
          workspaceId: world.northstar.workspaceId,
          name: 'Committed only if the whole unit succeeds',
        });
        await repository.create(tx, northstar, {
          workspaceId: world.twin.workspaceId, // fails
          name: 'Doomed',
        });
      }),
    ).rejects.toThrow();

    const after = await tenant.read(northstar, (tx) => repository.list(tx, northstar));
    expect(after).toHaveLength(before.length);
  });
});

describe('updates', () => {
  it('applies a scoped update and advances updated_at', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        workspaceId: world.northstar.workspaceId,
        name: 'Renameable',
      }),
    );

    const updated = await tenant.transaction(northstar, (tx) =>
      repository.update(tx, northstar, created.id, created.updatedAt, { name: 'Renamed' }),
    );

    expect(updated.name).toBe('Renamed');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('refuses a stale write', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        workspaceId: world.northstar.workspaceId,
        name: 'Concurrently edited',
      }),
    );
    // Two readers hold the same token; the second write must not silently win.
    await tenant.transaction(northstar, (tx) =>
      repository.update(tx, northstar, created.id, created.updatedAt, { name: 'First writer' }),
    );

    await expect(
      tenant.transaction(northstar, (tx) =>
        repository.update(tx, northstar, created.id, created.updatedAt, {
          name: 'Second writer',
        }),
      ),
    ).rejects.toThrow(ProjectVersionConflictError);

    const current = await tenant.read(northstar, (tx) =>
      repository.requireById(tx, northstar, created.id),
    );
    expect(current.name).toBe('First writer');
  });

  it('reports not-found rather than conflict when the caller is in the wrong tenant', async () => {
    const twinProject = await tenant.read(twin, (tx) =>
      repository.requireById(tx, twin, world.twin.projectId),
    );

    const error = await tenant
      .transaction(northstar, (tx) =>
        repository.update(tx, northstar, twinProject.id, twinProject.updatedAt, {
          name: 'Reaching across',
        }),
      )
      .catch((caught: unknown) => caught);

    // A conflict would confirm the row exists. Not-found is the answer that discloses
    // nothing, and the twin's row must be untouched.
    expect(error).toBeInstanceOf(ProjectNotFoundError);
    const untouched = await tenant.read(twin, (tx) =>
      repository.requireById(tx, twin, world.twin.projectId),
    );
    expect(untouched.name).toBe(twinProject.name);
  });

  it('archiving twice is not an error', async () => {
    const created = await tenant.transaction(northstar, (tx) =>
      repository.create(tx, northstar, {
        workspaceId: world.northstar.workspaceId,
        name: 'Archive me twice',
      }),
    );
    const once = await tenant.transaction(northstar, (tx) =>
      repository.archive(tx, northstar, created.id),
    );
    const twice = await tenant.transaction(northstar, (tx) =>
      repository.archive(tx, northstar, created.id),
    );
    expect(once.archivedAt).not.toBeNull();
    expect(twice.archivedAt?.getTime()).toBe(once.archivedAt?.getTime());
  });
});
