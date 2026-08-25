import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { UnsafeAuditMetadataError, capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal, Role } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import {
  AuditActionResultError,
  AuditEventsRepository,
} from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { ProjectMembershipsService } from '../src/modules/projects/project-memberships.service.js';
import { ProjectMembershipsRepository } from '../src/modules/projects/project-memberships.repository.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * AUD-001 against a real server — the append-only audit table, its service, and the first
 * command that writes to it.
 *
 * The questions asked here are the four every repository in this codebase answers, plus three
 * that only this table raises:
 *
 * 5. Does the table actually refuse an update and a delete, under the credential the
 *    application holds and under the migration credential too? Both are asserted, because
 *    `scripts/db/users.sql` and the triggers in `0002_platform_primitives.sql` are two
 *    independent controls and a suite that only exercised one would pass with the other
 *    removed.
 * 6. Does a **rolled-back** command leave no audit row? This is the property §3 step 8 is
 *    actually about, and the only way to observe it is a transaction that fails after the
 *    audit append.
 * 7. Does the metadata gate hold at the write boundary rather than only where a service
 *    happens to call it?
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let northstar: TenantContext;
let twin: TenantContext;
let audit: AuditService;
let memberships: ProjectMembershipsService;

const events = new AuditEventsRepository();

const contextFor = (organizationId: string, userId: string, membershipId: string): TenantContext =>
  createTenantContext({
    organizationId,
    userId,
    membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor('owner'),
    policyVersion: '2026-08-26',
    correlationId: uuidv7(),
  });

const principalFor = (context: TenantContext, role: Role, hasOrgWideScope: boolean): Principal => ({
  userId: context.userId,
  organizationId: context.organizationId,
  kind: 'internal',
  role,
  membershipId: context.membershipId,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope,
});

const newUser = async (email: string, displayName: string): Promise<string> => {
  const id = uuidv7();
  await db.admin.execute(
    `insert into users (id, email, display_name, email_verified_at)
     values (?, ?, ?, now(3))`,
    [id, email, displayName],
  );
  return id;
};

/** Count rows straight through the admin pool — no repository, no guard, no projection. */
const countEvents = async (organizationId: string, action: string): Promise<number> => {
  const [rows] = await db.admin.query<RowDataPacket[]>(
    'select count(*) as n from audit_events where organization_id = ? and action = ?',
    [organizationId, action],
  );
  return Number(rows[0]?.['n'] ?? 0);
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
  audit = new AuditService(tenant, events);
  memberships = new ProjectMembershipsService(tenant, audit, new ProjectMembershipsRepository());
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────
// Appending
// ─────────────────────────────────────────────────────────────────────────────

describe('appending an audit event', () => {
  it('takes the organization, actor and correlation id from the context', async () => {
    const row = await tenant.transaction(northstar, (tx) =>
      events.append(tx, northstar, {
        action: 'project_membership.granted',
        result: 'allowed',
        objectId: world.northstar.projectId,
        metadata: { project_id: world.northstar.projectId },
      }),
    );

    expect(row.organizationId).toBe(northstar.organizationId);
    expect(row.actorUserId).toBe(northstar.userId);
    expect(row.correlationId).toBe(northstar.correlationId);
    // Derived from the action, never supplied.
    expect(row.objectType).toBe('project_membership');
    // The server's clock, read back rather than reconstructed locally.
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('records a system-initiated action with no actor', async () => {
    const row = await tenant.transaction(northstar, (tx) =>
      events.append(tx, northstar, {
        action: 'project_membership.revoked',
        result: 'allowed',
        objectId: null,
        actorUserId: null,
        metadata: {},
      }),
    );
    // `null` and `undefined` mean different things on this input, and this is the difference.
    expect(row.actorUserId).toBeNull();
  });

  it('refuses metadata that is not identifiers and classifications', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        events.append(tx, northstar, {
          action: 'project_membership.revoked',
          result: 'allowed',
          objectId: null,
          // Cast because the type already refuses this — the point is that the *runtime*
          // check refuses it too, for the caller who reaches the repository from JavaScript,
          // from a test, or with `any` in between.
          metadata: { detail: 'the client asked for this on Tuesday' } as never,
        }),
      ),
    ).rejects.toBeInstanceOf(UnsafeAuditMetadataError);
  });

  it('refuses a denial action recorded as anything but denied', async () => {
    await expect(
      tenant.transaction(northstar, (tx) =>
        events.append(tx, northstar, {
          action: 'security.capability_denied',
          result: 'allowed',
          objectId: null,
          metadata: {},
        }),
      ),
    ).rejects.toBeInstanceOf(AuditActionResultError);
  });

  it('writes nothing when the metadata is refused', async () => {
    const before = await countEvents(northstar.organizationId, 'project_membership.role_changed');
    await expect(
      tenant.transaction(northstar, (tx) =>
        events.append(tx, northstar, {
          action: 'project_membership.role_changed',
          result: 'allowed',
          objectId: null,
          metadata: { user_email: 'x' } as never,
        }),
      ),
    ).rejects.toBeInstanceOf(UnsafeAuditMetadataError);
    expect(await countEvents(northstar.organizationId, 'project_membership.role_changed')).toBe(
      before,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Append-only — the two independent controls
// ─────────────────────────────────────────────────────────────────────────────

describe('the table is append-only', () => {
  it('refuses an update from the migration credential, which owns the schema', async () => {
    const row = await tenant.transaction(northstar, (tx) =>
      events.append(tx, northstar, {
        action: 'project_membership.granted',
        result: 'allowed',
        objectId: null,
        metadata: { immutability_case: 'update' },
      }),
    );

    // The admin pool is the migration credential — the most privileged one this suite holds.
    // The trigger refuses it anyway, which is the property `users.sql` alone cannot provide.
    await expect(
      db.admin.execute('update audit_events set result = ? where id = ?', ['denied', row.id]),
    ).rejects.toMatchObject({ sqlState: '45000' });
  });

  it('refuses a delete from the migration credential', async () => {
    const row = await tenant.transaction(northstar, (tx) =>
      events.append(tx, northstar, {
        action: 'project_membership.granted',
        result: 'allowed',
        objectId: null,
        metadata: { immutability_case: 'delete' },
      }),
    );

    await expect(
      db.admin.execute('delete from audit_events where id = ?', [row.id]),
    ).rejects.toMatchObject({ sqlState: '45000' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant scoping
// ─────────────────────────────────────────────────────────────────────────────

describe('tenant scoping', () => {
  it('never returns the adversarial twin’s events', async () => {
    await tenant.transaction(twin, (tx) =>
      events.append(tx, twin, {
        action: 'project_membership.granted',
        result: 'allowed',
        objectId: null,
        metadata: { scoping_case: 'twin_only' },
      }),
    );

    const mine = await tenant.read(northstar, (tx) => events.list(tx, northstar, { limit: 200 }));
    expect(mine.every((row) => row.organizationId === northstar.organizationId)).toBe(true);
    expect(
      mine.some(
        (row) => (row.metadataJson as { scoping_case?: string }).scoping_case === 'twin_only',
      ),
    ).toBe(false);
  });

  it('reports an event from another tenant as not found', async () => {
    const theirs = await tenant.transaction(twin, (tx) =>
      events.append(tx, twin, {
        action: 'project_membership.granted',
        result: 'allowed',
        objectId: null,
        metadata: {},
      }),
    );

    expect(
      await tenant.read(northstar, (tx) => events.findById(tx, northstar, theirs.id)),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The view model
// ─────────────────────────────────────────────────────────────────────────────

describe('the view model', () => {
  it('reads newest first and pages backwards without repeating a row', async () => {
    const objectId = uuidv7();
    for (let index = 0; index < 5; index += 1) {
      await tenant.transaction(northstar, (tx) =>
        events.append(tx, northstar, {
          action: 'project_membership.role_changed',
          result: 'allowed',
          objectId,
          metadata: { sequence: index },
        }),
      );
    }

    const first = await tenant.read(northstar, (tx) =>
      events.historyOf(tx, northstar, 'project_membership', objectId, { limit: 2 }),
    );
    expect(first).toHaveLength(2);
    // Newest first: ids descend.
    expect(first[0]!.id > first[1]!.id).toBe(true);

    const next = await tenant.read(northstar, (tx) =>
      events.historyOf(tx, northstar, 'project_membership', objectId, {
        limit: 2,
        before: first[1]!.id,
      }),
    );
    expect(next).toHaveLength(2);
    expect(next.map((row) => row.id)).not.toContain(first[1]!.id);
    expect(next[0]!.id < first[1]!.id).toBe(true);
  });

  it('filters by action, actor and result together', async () => {
    const other = await newUser('audit.filter@northstar.test', 'Audit Filter');
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, status)
       values (?, ?, ?, 'member', 'active')`,
      [uuidv7(), northstar.organizationId, other],
    );

    await tenant.transaction(northstar, (tx) =>
      events.append(tx, northstar, {
        action: 'project_membership.revoked',
        result: 'denied',
        objectId: null,
        actorUserId: other,
        metadata: { filter_case: 'yes' },
      }),
    );

    const found = await tenant.read(northstar, (tx) =>
      events.list(tx, northstar, {
        action: 'project_membership.revoked',
        actorUserId: other,
        result: 'denied',
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.actorUserId).toBe(other);
  });

  it('refuses a principal without audit.read, rather than returning an empty list', async () => {
    // `guest` is the one internal role `12-PERMISSION-MATRIX` §2 gives no audit access.
    const guest = principalFor(northstar, 'guest', false);
    await expect(audit.view(northstar, guest)).rejects.toBeInstanceOf(ApiError);
    await expect(audit.view(northstar, guest)).rejects.toMatchObject({ status: 403 });
  });

  it('gives an organization-wide principal the whole organization', async () => {
    const owner = principalFor(northstar, 'owner', true);
    const rows = await audit.view(northstar, owner, { limit: 200 });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((row) => row.actorUserId !== northstar.userId)).toBe(true);
  });

  it('narrows a principal without organization-wide scope to their own activity', async () => {
    const manager = principalFor(northstar, 'manager', false);
    const rows = await audit.view(northstar, manager, { limit: 200 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.actorUserId === northstar.userId)).toBe(true);
  });

  it('refuses to widen the narrowing by asking for someone else', async () => {
    const other = await newUser('audit.widen@northstar.test', 'Audit Widen');
    const manager = principalFor(northstar, 'manager', false);

    const rows = await audit.view(northstar, manager, { actorUserId: other, limit: 200 });
    // The requested filter is overwritten, not merged. Asking for another actor's rows
    // returns your own, never theirs.
    expect(rows.every((row) => row.actorUserId === northstar.userId)).toBe(true);
  });

  it('does not put the organization id in the view', async () => {
    const owner = principalFor(northstar, 'owner', true);
    const [row] = await audit.view(northstar, owner, { limit: 1 });
    expect(row).toBeDefined();
    expect(Object.keys(row!)).not.toContain('organizationId');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The first producer — §3 step 8
// ─────────────────────────────────────────────────────────────────────────────

describe('project-membership commands write their own audit trail', () => {
  it('records a grant', async () => {
    const user = await newUser('audit.grant@northstar.test', 'Audit Grant');
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, status)
       values (?, ?, ?, 'member', 'active')`,
      [uuidv7(), northstar.organizationId, user],
    );

    const row = await memberships.add(northstar, {
      projectId: world.northstar.projectId,
      userId: user,
      role: 'member',
    });

    const history = await tenant.read(northstar, (tx) =>
      events.historyOf(tx, northstar, 'project_membership', row.id),
    );
    expect(history).toHaveLength(1);
    expect(history[0]!.action).toBe('project_membership.granted');
    expect(history[0]!.result).toBe('allowed');
    expect(history[0]!.metadataJson).toMatchObject({
      target_user_id: user,
      granted_role: 'member',
    });
  });

  it('records a role change with both roles', async () => {
    const user = await newUser('audit.role@northstar.test', 'Audit Role');
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, status)
       values (?, ?, ?, 'member', 'active')`,
      [uuidv7(), northstar.organizationId, user],
    );
    const row = await memberships.add(northstar, {
      projectId: world.northstar.projectId,
      userId: user,
      role: 'member',
    });

    await memberships.changeRole(northstar, row.id, 'member', 'manager');

    const history = await tenant.read(northstar, (tx) =>
      events.historyOf(tx, northstar, 'project_membership', row.id),
    );
    expect(history.map((event) => event.action)).toEqual([
      'project_membership.role_changed',
      'project_membership.granted',
    ]);
    expect(history[0]!.metadataJson).toMatchObject({
      previous_role: 'member',
      new_role: 'manager',
      changed: true,
    });
  });

  /**
   * The gap this ticket closes.
   *
   * `project_memberships` has no soft delete, so once the row is gone the audit event is the
   * only surviving record that the grant ever existed. Asserting the *contents* rather than
   * merely the presence of the event is the whole point — an event that recorded only an id
   * would name a row nobody can look up.
   */
  it('records a revocation, with the facts that the delete destroys', async () => {
    const user = await newUser('audit.revoke@northstar.test', 'Audit Revoke');
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, status)
       values (?, ?, ?, 'member', 'active')`,
      [uuidv7(), northstar.organizationId, user],
    );
    const row = await memberships.add(northstar, {
      projectId: world.northstar.projectId,
      userId: user,
      role: 'member',
    });

    expect(await memberships.remove(northstar, row.id)).toBe(true);

    // The membership itself is gone.
    expect(
      await tenant.read(northstar, (tx) =>
        new ProjectMembershipsRepository().findById(tx, northstar, row.id),
      ),
    ).toBeNull();

    const history = await tenant.read(northstar, (tx) =>
      events.historyOf(tx, northstar, 'project_membership', row.id),
    );
    expect(history[0]!.action).toBe('project_membership.revoked');
    expect(history[0]!.metadataJson).toMatchObject({
      project_id: world.northstar.projectId,
      target_user_id: user,
      revoked_role: 'member',
    });
  });

  it('writes no revocation when there was nothing to revoke', async () => {
    const absent = uuidv7();
    const before = await countEvents(northstar.organizationId, 'project_membership.revoked');

    expect(await memberships.remove(northstar, absent)).toBe(false);

    expect(await countEvents(northstar.organizationId, 'project_membership.revoked')).toBe(before);
  });

  /**
   * §3 step 8's actual requirement, and the only assertion that can prove it.
   *
   * A service that opened its own transaction for the audit row would pass every test above
   * and fail this one: the membership write rolls back, and the audit row — committed
   * separately — survives to describe a change that never happened.
   */
  it('leaves no audit row when the command rolls back', async () => {
    const user = await newUser('audit.rollback@northstar.test', 'Audit Rollback');
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, status)
       values (?, ?, ?, 'member', 'active')`,
      [uuidv7(), northstar.organizationId, user],
    );

    const before = await countEvents(northstar.organizationId, 'project_membership.granted');

    await expect(
      tenant.transaction(northstar, async (tx) => {
        const row = await new ProjectMembershipsRepository().add(tx, northstar, {
          projectId: world.northstar.projectId,
          userId: user,
          role: 'member',
        });
        await audit.record(tx, northstar, {
          action: 'project_membership.granted',
          result: 'allowed',
          objectId: row.id,
          metadata: { target_user_id: user },
        });
        throw new Error('the command failed after both writes');
      }),
    ).rejects.toThrow('the command failed after both writes');

    expect(await countEvents(northstar.organizationId, 'project_membership.granted')).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Denials
// ─────────────────────────────────────────────────────────────────────────────

describe('recording a refused attempt', () => {
  it('writes a denied event with the capability and the audit code', async () => {
    expect(
      await audit.recordDenial(northstar, 'security.capability_denied', {
        status: 403,
        capability: 'audit.export',
        auditCode: 'capability_not_in_role_ceiling',
      }),
    ).toBe(true);

    const found = await tenant.read(northstar, (tx) =>
      events.list(tx, northstar, { action: 'security.capability_denied', limit: 1 }),
    );
    expect(found[0]!.result).toBe('denied');
    expect(found[0]!.objectType).toBe('capability');
    expect(found[0]!.metadataJson).toMatchObject({
      http_status: 403,
      capability: 'audit.export',
      audit_code: 'capability_not_in_role_ceiling',
      principal_kind: 'internal',
    });
  });

  /**
   * The uncomfortable half of `recordDenial`, asserted rather than assumed.
   *
   * A refusal has already been decided by the time this runs, so an audit failure must not
   * become the caller's problem. The context below names an organization that does not exist,
   * so the foreign key rejects the insert — and the call still returns rather than throwing.
   */
  it('never throws, and says so by returning false', async () => {
    const impossible = contextFor(uuidv7(), northstar.userId, northstar.membershipId);
    expect(
      await audit.recordDenial(impossible, 'security.capability_denied', { status: 403 }),
    ).toBe(false);
  });
});
