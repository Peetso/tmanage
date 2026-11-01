import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { CAPABILITIES, capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { CustomRolesRepository } from '../src/modules/admin/roles.repository.js';
import { RoleEditRepository } from '../src/modules/admin/role-edit.repository.js';
import { PoliciesRepository } from '../src/modules/admin/policies.repository.js';
import { SecuritySettingsRepository } from '../src/modules/admin/security.repository.js';
import { AdminExportRequestsRepository } from '../src/modules/admin/export-requests.repository.js';
import { normalizePolicy } from '../src/modules/admin/policies.allowlist.js';
import type { OrgPolicyValue } from '../src/common/database/schema.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * T005 — the Administration governance data layer against a real server and the §11 adversarial
 * twin: custom roles, access policies, security settings and data-export requests.
 *
 * What only this suite can prove (module 18 is built-since-proof; RBAC escalation is T013, this is
 * the data half):
 *
 * 1. **A tenant sees only its own rows.** Northstar Studio and its near-identical twin (adjacent id,
 *    identical names) each own custom roles, a policy document, a security posture and export
 *    requests; every tenant-scoped read returns the acting tenant's rows and never the twin's, so a
 *    lost `organization_id` predicate — the exact bug the adjacent id is engineered to expose —
 *    would surface here as the twin's rows leaking in rather than as a clean miss.
 * 2. **A custom role's capability set is an allowlisted subset that round-trips.** Every stored
 *    capability is a member of the fixed `CAPABILITIES` allowlist, and the subset is read back
 *    verbatim; the engine's `uq_custom_roles_org_name` makes a duplicate name a conflict per org,
 *    not a second row, while the same name in the twin is a different role entirely.
 * 3. **One policy / security row per organization.** The upsert overwrites in place; a re-save never
 *    forks a second row, and the `0072` / `0073` triggers hold `organization_id` immutable at the
 *    engine where a raw session would bypass the application layers.
 * 4. **A policy CRUD round trip** — absent-before-write, write, read, overwrite — preserves the typed
 *    document.
 * 5. **An export request's lifecycle persists** from `pending`, its `requested_at` is the bound
 *    instant the admin asked (never the SYSTEM admin-pool clock), and the `0098` trigger pins scope,
 *    requester, instant and tenant while leaving `status` for the later worker to advance.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let northstarCtx: TenantContext;
let twinCtx: TenantContext;

const roles = new CustomRolesRepository();
const roleEdit = new RoleEditRepository();
const policies = new PoliciesRepository();
const security = new SecuritySettingsRepository();
const exportRequests = new AdminExportRequestsRepository();

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

function contextFor(organizationId: string, userId: string, membershipId: string): TenantContext {
  return createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-30',
    correlationId: uuidv7(),
  });
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
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

  northstarCtx = contextFor(
    world.northstar.organizationId,
    world.northstar.owner.id,
    world.northstar.owner.membershipId,
  );
  twinCtx = contextFor(
    world.twin.organizationId,
    world.twin.owner.id,
    world.twin.owner.membershipId,
  );
});

afterAll(async () => {
  await db?.stop();
});

describe('custom roles — tenant isolation, allowlist persistence, duplicate names', () => {
  // Every capability is a real member of the fixed allowlist (12-PERMISSION-MATRIX §2).
  const releaseCaps = ['work.read', 'work.create', 'project.manage'] as const;
  const reviewerCaps = ['work.read', 'approval.read', 'approval.decide'] as const;

  it('persists an allowlisted capability subset and lists only the acting tenant, by name', async () => {
    await tenant.transaction(northstarCtx, (tx) =>
      roles.insert(tx, northstarCtx, {
        name: 'Release Captain',
        capabilities: releaseCaps,
        createdBy: world.northstar.owner.id,
      }),
    );
    await tenant.transaction(northstarCtx, (tx) =>
      roles.insert(tx, northstarCtx, {
        name: 'Approvals Reviewer',
        capabilities: reviewerCaps,
        createdBy: world.northstar.owner.id,
      }),
    );
    // The twin defines a role with the IDENTICAL name — a different tenant, so no conflict, and it
    // must never appear in Northstar's list.
    await tenant.transaction(twinCtx, (tx) =>
      roles.insert(tx, twinCtx, {
        name: 'Release Captain',
        capabilities: ['work.read'],
        createdBy: world.twin.owner.id,
      }),
    );

    const list = await tenant.read(northstarCtx, (r) => roles.listAll(r, northstarCtx));
    expect(list.map((row) => row.name)).toEqual(['Approvals Reviewer', 'Release Captain']);

    const captain = list.find((row) => row.name === 'Release Captain');
    const stored = JSON.parse(captain?.capabilitiesJson ?? '[]') as string[];
    // The subset round-trips verbatim, and every element is an allowlisted capability.
    expect(stored).toEqual([...releaseCaps]);
    for (const cap of stored) {
      expect(CAPABILITIES as readonly string[]).toContain(cap);
    }

    // The twin owns exactly one 'Release Captain', with a different id and its own narrower subset.
    const twinList = await tenant.read(twinCtx, (r) => roles.listAll(r, twinCtx));
    expect(twinList.map((row) => row.name)).toEqual(['Release Captain']);
    expect(twinList[0]?.id).not.toBe(captain?.id);
    expect(twinList[0]?.organizationId).toBe(world.twin.organizationId);
  });

  it('resolves a name to the acting tenant only, never the twin with the same name', async () => {
    const forNorthstar = await tenant.read(northstarCtx, (r) =>
      roles.findByName(r, northstarCtx, 'Release Captain'),
    );
    const forTwin = await tenant.read(twinCtx, (r) =>
      roles.findByName(r, twinCtx, 'Release Captain'),
    );
    expect(forNorthstar?.organizationId).toBe(world.northstar.organizationId);
    expect(forTwin?.organizationId).toBe(world.twin.organizationId);
    expect(forNorthstar?.id).not.toBe(forTwin?.id);

    // A name only the twin's manager would know is a clean miss in Northstar, not a cross read.
    const absent = await tenant.read(northstarCtx, (r) =>
      roles.findByName(r, northstarCtx, 'No Such Role In Northstar'),
    );
    expect(absent).toBeUndefined();
  });

  it('the engine refuses a duplicate role name within one organization', async () => {
    await expect(
      tenant.transaction(northstarCtx, (tx) =>
        roles.insert(tx, northstarCtx, {
          name: 'Release Captain',
          capabilities: ['work.read'],
          createdBy: world.northstar.owner.id,
        }),
      ),
    ).rejects.toThrow(/Duplicate entry/);
  });

  it('clone + edit are scoped on (organization_id, id); a twin role is a not-found, never an edit', async () => {
    const captain = await tenant.read(northstarCtx, (r) =>
      roleEdit.findByName(r, northstarCtx, 'Release Captain'),
    );
    const captainId = captain?.id;
    expect(captainId).toBeDefined();

    // The twin's same-named role id is invisible to Northstar's by-id resolve.
    const twinCaptain = await tenant.read(twinCtx, (r) =>
      roleEdit.findByName(r, twinCtx, 'Release Captain'),
    );
    const twinCaptainId = twinCaptain?.id as string;
    const crossRead = await tenant.read(northstarCtx, (r) =>
      roleEdit.findById(r, northstarCtx, twinCaptainId),
    );
    expect(crossRead).toBeUndefined();

    // Editing the twin's role under Northstar's context updates nothing and resolves not-found (404).
    await expectApiError(
      tenant.transaction(northstarCtx, (tx) =>
        roleEdit.update(tx, northstarCtx, {
          id: twinCaptainId,
          name: 'Hijacked',
          capabilities: ['org.manage'],
        }),
      ),
      404,
    );

    // The twin's row is untouched by that attempt.
    const twinAfter = await tenant.read(twinCtx, (r) =>
      roleEdit.findById(r, twinCtx, twinCaptainId),
    );
    expect(twinAfter?.name).toBe('Release Captain');
    expect(JSON.parse(twinAfter?.capabilitiesJson ?? '[]')).toEqual(['work.read']);

    // A legitimate in-tenant edit renames and re-capabilities Northstar's own role in place.
    const updated = await tenant.transaction(northstarCtx, (tx) =>
      roleEdit.update(tx, northstarCtx, {
        id: captainId as string,
        name: 'Release Lead',
        capabilities: ['work.read', 'work.transition'],
      }),
    );
    expect(updated.name).toBe('Release Lead');
    expect(JSON.parse(updated.capabilitiesJson)).toEqual(['work.read', 'work.transition']);
  });
});

describe('organization access policies — CRUD round trip and one row per org', () => {
  const policyA: OrgPolicyValue = {
    session_max_hours: 72,
    invite_domain_allowlist: ['northstar.example'],
    guest_access_enabled: true,
    idle_signout_minutes: 480,
  };
  const policyB: OrgPolicyValue = {
    session_max_hours: 12,
    invite_domain_allowlist: [],
    guest_access_enabled: false,
    idle_signout_minutes: 30,
  };
  const twinPolicy: OrgPolicyValue = {
    session_max_hours: 240,
    invite_domain_allowlist: ['northstar-studios.example'],
    guest_access_enabled: true,
    idle_signout_minutes: 0,
  };

  it('reads absent before any write, then round-trips the written document', async () => {
    const before = await tenant.read(northstarCtx, (r) => policies.find(r, northstarCtx));
    expect(before).toBeUndefined();

    await tenant.transaction(northstarCtx, (tx) =>
      policies.upsert(tx, northstarCtx, { policy: policyA, updatedBy: world.northstar.owner.id }),
    );
    const after = await tenant.read(northstarCtx, (r) => policies.find(r, northstarCtx));
    expect(after).toBeDefined();
    expect(normalizePolicy(after?.policyJson)).toEqual(policyA);
    expect(after?.updatedBy).toBe(world.northstar.owner.id);
  });

  it('a re-save overwrites in place — exactly one row per organization', async () => {
    await tenant.transaction(northstarCtx, (tx) =>
      policies.upsert(tx, northstarCtx, { policy: policyB, updatedBy: world.northstar.manager.id }),
    );
    const after = await tenant.read(northstarCtx, (r) => policies.find(r, northstarCtx));
    expect(normalizePolicy(after?.policyJson)).toEqual(policyB);
    expect(after?.updatedBy).toBe(world.northstar.manager.id);

    const rows = await observe(`select count(*) as n from org_policies where organization_id = ?`, [
      world.northstar.organizationId,
    ]);
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  it('the twin keeps its own document; neither tenant reads the other', async () => {
    await tenant.transaction(twinCtx, (tx) =>
      policies.upsert(tx, twinCtx, { policy: twinPolicy, updatedBy: world.twin.owner.id }),
    );
    const forNorthstar = await tenant.read(northstarCtx, (r) => policies.find(r, northstarCtx));
    const forTwin = await tenant.read(twinCtx, (r) => policies.find(r, twinCtx));
    expect(normalizePolicy(forNorthstar?.policyJson)).toEqual(policyB);
    expect(normalizePolicy(forTwin?.policyJson)).toEqual(twinPolicy);

    const rows = await observe(`select count(*) as n from org_policies`);
    expect(Number(rows[0]?.['n'])).toBe(2);
  });

  it('the engine holds organization_id immutable', async () => {
    await expect(
      db.admin.execute(`update org_policies set organization_id = ? where organization_id = ?`, [
        world.twin.organizationId,
        world.northstar.organizationId,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('security settings — one row per org, isolation, immutable identity', () => {
  it('stores the posture, reads it back typed, and overwrites in place', async () => {
    await tenant.transaction(northstarCtx, (tx) =>
      security.upsert(tx, northstarCtx, {
        enforce2fa: true,
        ipAllowlist: ['203.0.113.0/24', '198.51.100.4'],
        updatedBy: world.northstar.owner.id,
      }),
    );
    const first = await tenant.read(northstarCtx, (r) => security.find(r, northstarCtx));
    expect(typeof first?.enforce2fa).toBe('boolean');
    expect(first?.enforce2fa).toBe(true);
    expect(first?.ipAllowlistJson).toEqual(['203.0.113.0/24', '198.51.100.4']);

    await tenant.transaction(northstarCtx, (tx) =>
      security.upsert(tx, northstarCtx, {
        enforce2fa: false,
        ipAllowlist: [],
        updatedBy: world.northstar.manager.id,
      }),
    );
    const second = await tenant.read(northstarCtx, (r) => security.find(r, northstarCtx));
    expect(second?.enforce2fa).toBe(false);
    expect(second?.ipAllowlistJson).toEqual([]);
    expect(second?.updatedBy).toBe(world.northstar.manager.id);

    const rows = await observe(
      `select count(*) as n from security_settings where organization_id = ?`,
      [world.northstar.organizationId],
    );
    expect(Number(rows[0]?.['n'])).toBe(1);
  });

  it('the twin posture is separate; neither tenant reads the other', async () => {
    await tenant.transaction(twinCtx, (tx) =>
      security.upsert(tx, twinCtx, {
        enforce2fa: true,
        ipAllowlist: ['192.0.2.0/24'],
        updatedBy: world.twin.owner.id,
      }),
    );
    const forNorthstar = await tenant.read(northstarCtx, (r) => security.find(r, northstarCtx));
    const forTwin = await tenant.read(twinCtx, (r) => security.find(r, twinCtx));
    expect(forNorthstar?.enforce2fa).toBe(false);
    expect(forNorthstar?.ipAllowlistJson).toEqual([]);
    expect(forTwin?.enforce2fa).toBe(true);
    expect(forTwin?.ipAllowlistJson).toEqual(['192.0.2.0/24']);

    const rows = await observe(`select count(*) as n from security_settings`);
    expect(Number(rows[0]?.['n'])).toBe(2);
  });

  it('the engine holds organization_id immutable', async () => {
    await expect(
      db.admin.execute(
        `update security_settings set organization_id = ? where organization_id = ?`,
        [world.twin.organizationId, world.northstar.organizationId],
      ),
    ).rejects.toThrow(/immutable/);
  });
});

describe('admin export requests — lifecycle, the bound clock, immutable facts', () => {
  // Instants deliberately in the past: the stored value must be these, not whatever the writing
  // (SYSTEM-clock) admin connection reads "now".
  const askedFull = new Date('2026-02-01T09:30:00.000Z');
  const askedMembers = new Date('2026-02-02T14:00:00.000Z');
  const askedTwin = new Date('2026-02-03T08:15:00.000Z');

  it('records requests in pending, ordered by the bound requested_at', async () => {
    await tenant.transaction(northstarCtx, (tx) =>
      exportRequests.insert(tx, northstarCtx, {
        scope: 'full',
        requestedBy: world.northstar.owner.id,
        requestedAt: askedFull,
      }),
    );
    await tenant.transaction(northstarCtx, (tx) =>
      exportRequests.insert(tx, northstarCtx, {
        scope: 'members',
        requestedBy: world.northstar.manager.id,
        requestedAt: askedMembers,
      }),
    );

    const list = await tenant.read(northstarCtx, (r) => exportRequests.listAll(r, northstarCtx));
    expect(list.map((row) => row.scope)).toEqual(['full', 'members']);
    expect(list.every((row) => row.status === 'pending')).toBe(true);
    // The bound instant persisted — not the SYSTEM clock of the writing connection.
    expect(list[0]?.requestedAt.getTime()).toBe(askedFull.getTime());
    expect(list[1]?.requestedAt.getTime()).toBe(askedMembers.getTime());
    expect(list[0]?.requestedBy).toBe(world.northstar.owner.id);
  });

  it('the twin requests are isolated from Northstar', async () => {
    await tenant.transaction(twinCtx, (tx) =>
      exportRequests.insert(tx, twinCtx, {
        scope: 'billing',
        requestedBy: world.twin.owner.id,
        requestedAt: askedTwin,
      }),
    );
    const forNorthstar = await tenant.read(northstarCtx, (r) =>
      exportRequests.listAll(r, northstarCtx),
    );
    expect(forNorthstar.map((row) => row.scope)).toEqual(['full', 'members']);
    expect(forNorthstar.some((row) => row.scope === 'billing')).toBe(false);

    const forTwin = await tenant.read(twinCtx, (r) => exportRequests.listAll(r, twinCtx));
    expect(forTwin.map((row) => row.scope)).toEqual(['billing']);

    const rows = await observe(`select count(*) as n from admin_export_requests`);
    expect(Number(rows[0]?.['n'])).toBe(3);
  });

  it('status advances through the lifecycle while the request facts stay pinned', async () => {
    const list = await tenant.read(northstarCtx, (r) => exportRequests.listAll(r, northstarCtx));
    const full = list.find((row) => row.scope === 'full');
    const id = full?.id as string;

    // The later worker's job: move pending → completed. The lifecycle column is the only mover.
    await db.admin.execute(`update admin_export_requests set status = 'completed' where id = ?`, [
      id,
    ]);
    const after = await tenant.read(northstarCtx, (r) => exportRequests.listAll(r, northstarCtx));
    expect(after.find((row) => row.id === id)?.status).toBe('completed');

    // The 0098 trigger pins scope, requester, instant and tenant against any amendment.
    await expect(
      db.admin.execute(`update admin_export_requests set scope = 'projects' where id = ?`, [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.execute(`update admin_export_requests set requested_by = ? where id = ?`, [
        world.twin.owner.id,
        id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.execute(
        `update admin_export_requests set requested_at = '2020-01-01 00:00:00.000' where id = ?`,
        [id],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.admin.execute(`update admin_export_requests set organization_id = ? where id = ?`, [
        world.twin.organizationId,
        id,
      ]),
    ).rejects.toThrow(/immutable/);
  });
});
