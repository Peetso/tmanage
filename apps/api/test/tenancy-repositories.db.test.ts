import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorize, uuidv7, type InternalRole } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
} from '../src/modules/tenancy/membership-resolver.repository.js';
import type { ResolvedMembership } from '../src/modules/tenancy/membership-resolver.repository.js';
import {
  OrganizationVersionConflictError,
  OrganizationsRepository,
} from '../src/modules/tenancy/organizations.repository.js';
import {
  WorkspaceNotFoundError,
  WorkspaceVersionConflictError,
  WorkspacesRepository,
} from '../src/modules/tenancy/workspaces.repository.js';
import {
  MembershipNotFoundError,
  MembershipTransitionError,
  MembershipVersionConflictError,
  MembershipsRepository,
} from '../src/modules/tenancy/memberships.repository.js';
import { PrincipalRepository } from '../src/modules/tenancy/principal.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * TEN-001's remaining aggregates and TEN-002's evaluator wiring, against a real server and
 * the adversarial tenant pair.
 *
 * Every context here is produced by the membership resolver rather than hand-assembled, so
 * the suite exercises the whole chain the HTTP layer will use: a claimed organization, a
 * membership row that proves or refuses it, and only then a scoped repository call. Building
 * contexts with `createTenantContext` directly would test the repositories against a tenant
 * nobody had verified, which is the one thing spec section 2 is written to prevent.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let resolver: MembershipResolver;

const organizations = new OrganizationsRepository();
const workspaces = new WorkspacesRepository();
const memberships = new MembershipsRepository();
const principals = new PrincipalRepository();

let northstarOwner: ResolvedMembership;
let northstarMember: ResolvedMembership;
let twinOwner: ResolvedMembership;
let atlasReviewer: ResolvedMembership;

const contextOf = (resolved: ResolvedMembership): TenantContext => resolved.context;

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  guardEvents = [];
  tenant = new TenantDatabase(db.runtime, {
    guardMode: 'enforce',
    onGuardEvent: (event) => guardEvents.push(event),
  });
  resolver = new MembershipResolver(tenant);

  const resolve = (userId: string, slug: string) =>
    resolver.resolve({ userId, organization: { slug }, correlationId: uuidv7() });

  northstarOwner = await resolve(world.northstar.owner.id, 'northstar-studio');
  northstarMember = await resolve(world.northstar.designer.id, 'northstar-studio');
  twinOwner = await resolve(world.twin.owner.id, 'northstar-studios');
  atlasReviewer = await resolve(world.atlas.reviewer.id, 'northstar-studio');
});

afterAll(async () => {
  await db?.stop();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the organization aggregate', () => {
  it('reads the acting organization and no other', async () => {
    const mine = await tenant.read(contextOf(northstarOwner), (tx) =>
      organizations.requireCurrent(tx, contextOf(northstarOwner)),
    );
    const theirs = await tenant.read(contextOf(twinOwner), (tx) =>
      organizations.requireCurrent(tx, contextOf(twinOwner)),
    );

    expect(mine.id).toBe(world.northstar.organizationId);
    expect(mine.name).toBe('Northstar Studio');
    expect(theirs.id).toBe(world.twin.organizationId);
    expect(theirs.name).toBe('Northstar Studios');
  });

  it('has no method that can name another organization', () => {
    // Structural rather than behavioural: there is no `findById(id)` to call. If one is ever
    // added, this stops compiling and the typecheck gate fails.
    // @ts-expect-error the repository intentionally exposes no organization-by-id lookup
    expect(typeof organizations.findById).toBe('undefined');
  });

  it('updates settings and refuses a stale write', async () => {
    const before = await tenant.read(contextOf(twinOwner), (tx) =>
      organizations.requireCurrent(tx, contextOf(twinOwner)),
    );

    const updated = await tenant.transaction(contextOf(twinOwner), (tx) =>
      organizations.update(tx, contextOf(twinOwner), before.updatedAt, {
        timezone: 'Africa/Cairo',
      }),
    );
    expect(updated.timezone).toBe('Africa/Cairo');

    await expect(
      tenant.transaction(contextOf(twinOwner), (tx) =>
        organizations.update(tx, contextOf(twinOwner), before.updatedAt, { timezone: 'UTC' }),
      ),
    ).rejects.toThrow(OrganizationVersionConflictError);

    // The twin's neighbour is untouched by either attempt.
    const neighbour = await tenant.read(contextOf(northstarOwner), (tx) =>
      organizations.requireCurrent(tx, contextOf(northstarOwner)),
    );
    expect(neighbour.timezone).toBe('UTC');
  });

  it('archiving an organization stops anyone resolving into it', async () => {
    const brightops = await resolver.resolve({
      userId: world.brightops.owner.id,
      organization: { slug: 'brightops-consulting' },
      correlationId: uuidv7(),
    });

    await tenant.transaction(brightops.context, (tx) =>
      organizations.archive(tx, brightops.context),
    );

    // The context already in hand keeps working — it was verified before the archive, and
    // revoking it is a session concern. What stops is the *next* resolution.
    await expect(
      resolver.resolve({
        userId: world.brightops.owner.id,
        organization: { slug: 'brightops-consulting' },
        correlationId: uuidv7(),
      }),
    ).rejects.toThrow(MembershipNotResolvedError);

    await db.admin.execute('update organizations set archived_at = null where id = ?', [
      world.brightops.organizationId,
    ]);
  });
});

describe('the workspace aggregate', () => {
  it('lists only the acting tenant’s workspaces', async () => {
    const mine = await tenant.read(contextOf(northstarOwner), (tx) =>
      workspaces.list(tx, contextOf(northstarOwner)),
    );
    expect(mine.map((row) => row.id)).toContain(world.northstar.workspaceId);
    expect(mine.map((row) => row.id)).not.toContain(world.twin.workspaceId);
    expect(mine.every((row) => row.organizationId === world.northstar.organizationId)).toBe(true);
  });

  it('returns null for a direct-id lookup of the twin’s workspace', async () => {
    const found = await tenant.read(contextOf(northstarOwner), (tx) =>
      workspaces.findById(tx, contextOf(northstarOwner), world.twin.workspaceId),
    );
    expect(found).toBeNull();
  });

  it('creates in the acting tenant and cannot be told which tenant to write into', async () => {
    const before = await tenant.read(contextOf(twinOwner), (tx) =>
      workspaces.list(tx, contextOf(twinOwner)),
    );

    const created = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      workspaces.create(tx, contextOf(northstarOwner), {
        name: 'Internal Operations',
        // @ts-expect-error organizationId is derived from TenantContext, never from input
        organizationId: world.twin.organizationId,
      }),
    );

    expect(created.organizationId).toBe(world.northstar.organizationId);
    expect(created.createdAt).toBeInstanceOf(Date);

    const after = await tenant.read(contextOf(twinOwner), (tx) =>
      workspaces.list(tx, contextOf(twinOwner)),
    );
    expect(after).toHaveLength(before.length);
  });

  it('refuses a stale update and reports not-found across the tenant boundary', async () => {
    const created = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      workspaces.create(tx, contextOf(northstarOwner), { name: 'Concurrently edited' }),
    );

    await tenant.transaction(contextOf(northstarOwner), (tx) =>
      workspaces.update(tx, contextOf(northstarOwner), created.id, created.updatedAt, {
        name: 'First writer',
      }),
    );

    await expect(
      tenant.transaction(contextOf(northstarOwner), (tx) =>
        workspaces.update(tx, contextOf(northstarOwner), created.id, created.updatedAt, {
          name: 'Second writer',
        }),
      ),
    ).rejects.toThrow(WorkspaceVersionConflictError);

    // The same stale token from the wrong tenant is not-found, not a conflict: a conflict
    // would confirm the row exists.
    const error = await tenant
      .transaction(contextOf(twinOwner), (tx) =>
        workspaces.update(tx, contextOf(twinOwner), created.id, created.updatedAt, {
          name: 'Reaching across',
        }),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceNotFoundError);
    expect((error as Error).message).not.toContain(world.northstar.organizationId);
  });

  it('paginates by keyset and archives idempotently', async () => {
    const all = await tenant.read(contextOf(northstarOwner), (tx) =>
      workspaces.list(tx, contextOf(northstarOwner), { includeArchived: true, limit: 200 }),
    );
    const first = await tenant.read(contextOf(northstarOwner), (tx) =>
      workspaces.list(tx, contextOf(northstarOwner), { includeArchived: true, limit: 1 }),
    );
    const second = await tenant.read(contextOf(northstarOwner), (tx) =>
      workspaces.list(tx, contextOf(northstarOwner), {
        includeArchived: true,
        limit: 1,
        after: first[0]?.id as string,
      }),
    );
    expect(first[0]?.id).toBe(all[0]?.id);
    expect(second[0]?.id).toBe(all[1]?.id);

    const created = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      workspaces.create(tx, contextOf(northstarOwner), { name: 'Archive me twice' }),
    );
    const once = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      workspaces.archive(tx, contextOf(northstarOwner), created.id),
    );
    const twice = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      workspaces.archive(tx, contextOf(northstarOwner), created.id),
    );
    expect(once.archivedAt).not.toBeNull();
    expect(twice.archivedAt?.getTime()).toBe(once.archivedAt?.getTime());

    const visible = await tenant.read(contextOf(northstarOwner), (tx) =>
      workspaces.list(tx, contextOf(northstarOwner)),
    );
    expect(visible.map((row) => row.id)).not.toContain(created.id);
  });
});

describe('the membership aggregate', () => {
  it('lists active memberships by default and the invited only on request', async () => {
    const active = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.list(tx, contextOf(northstarOwner)),
    );
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((row) => row.status === 'active')).toBe(true);
    expect(active.every((row) => row.organizationId === world.northstar.organizationId)).toBe(true);

    const invited = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.list(tx, contextOf(northstarOwner), { statuses: ['invited'] }),
    );
    expect(invited.every((row) => row.status === 'invited')).toBe(true);
  });

  it('reports not-found for the twin’s membership rather than disclosing it', async () => {
    const error = await tenant
      .read(contextOf(northstarOwner), (tx) =>
        memberships.requireById(tx, contextOf(northstarOwner), world.twin.owner.membershipId),
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MembershipNotFoundError);
    expect((error as Error).message).not.toContain(world.twin.organizationId);
  });

  it('an invitation authorises nothing until it is accepted', async () => {
    // Tarek exists as a user and belongs to BrightOps; he has no Northstar membership.
    const invited = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.invite(tx, contextOf(northstarOwner), {
        userId: world.brightops.owner.id,
        role: 'manager',
      }),
    );
    expect(invited.status).toBe('invited');
    expect(invited.hasOrgWideScope).toBe(false);

    await expect(
      resolver.resolve({
        userId: world.brightops.owner.id,
        organization: { slug: 'northstar-studio' },
        correlationId: uuidv7(),
      }),
    ).rejects.toThrow(MembershipNotResolvedError);

    const accepted = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.transitionStatus(
        tx,
        contextOf(northstarOwner),
        invited.id,
        invited.version,
        'active',
      ),
    );
    expect(accepted.status).toBe('active');
    expect(accepted.version).toBe(invited.version + 1);

    const resolved = await resolver.resolve({
      userId: world.brightops.owner.id,
      organization: { slug: 'northstar-studio' },
      correlationId: uuidv7(),
    });
    expect(resolved.context.membershipId).toBe(invited.id);
    expect(resolved.role).toBe('manager');

    // A second invitation for the same person is refused by `uq_memberships_org_user`,
    // rather than by a check-then-insert that two concurrent admins could both pass.
    await expect(
      tenant.transaction(contextOf(northstarOwner), (tx) =>
        memberships.invite(tx, contextOf(northstarOwner), {
          userId: world.brightops.owner.id,
          role: 'member',
        }),
      ),
    ).rejects.toThrow(/duplicate/i);

    await db.admin.execute('delete from memberships where id = ?', [invited.id]);
  });

  it('derives organization-wide scope from the role, and takes an explicit override', async () => {
    const owner = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.requireById(tx, contextOf(northstarOwner), world.northstar.owner.membershipId),
    );
    expect(owner.hasOrgWideScope).toBe(true);

    const designer = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.requireById(tx, contextOf(northstarOwner), world.northstar.designer.membershipId),
    );

    const promoted = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.changeRole(
        tx,
        contextOf(northstarOwner),
        designer.id,
        designer.version,
        'org_admin',
      ),
    );
    expect(promoted.role).toBe('org_admin');
    expect(promoted.hasOrgWideScope).toBe(true);

    // A workspace admin is workspace-scoped, so the default is false — and an organization
    // that wants otherwise says so explicitly rather than getting it from the role name.
    const scoped = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.changeRole(
        tx,
        contextOf(northstarOwner),
        designer.id,
        promoted.version,
        'workspace_admin',
      ),
    );
    expect(scoped.hasOrgWideScope).toBe(false);

    const overridden = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.changeRole(
        tx,
        contextOf(northstarOwner),
        designer.id,
        scoped.version,
        'workspace_admin',
        true,
      ),
    );
    expect(overridden.hasOrgWideScope).toBe(true);

    await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.changeRole(
        tx,
        contextOf(northstarOwner),
        designer.id,
        overridden.version,
        'member',
      ),
    );
  });

  it('bumps the membership policy_version by exactly one on a role change, and a rename does not', async () => {
    // A2 acceptance ("version-bump-on-role-change", 0023): the authorization epoch stored on the
    // membership rotates through the *real* changeRole command — not a raw UPDATE standing in for
    // it — so a regression dropping `policy_version + 1` from the repository would fail here. The
    // second half pins the other side of the same decision: a rename is a settings write and must
    // leave every epoch alone, which is exactly the `updated_at` churn 0023 removed.
    const before = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.requireById(tx, contextOf(northstarOwner), world.northstar.designer.membershipId),
    );
    const original = before.role as InternalRole;
    const target: InternalRole = original === 'moderator' ? 'member' : 'moderator';

    const changed = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.changeRole(tx, contextOf(northstarOwner), before.id, before.version, target),
    );
    expect(changed.role).toBe(target);
    expect(changed.policyVersion).toBe(before.policyVersion + 1);

    const orgBefore = await tenant.read(contextOf(northstarOwner), (tx) =>
      organizations.requireCurrent(tx, contextOf(northstarOwner)),
    );
    const renamed = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      organizations.update(tx, contextOf(northstarOwner), orgBefore.updatedAt, {
        name: `${orgBefore.name} (renamed)`,
      }),
    );
    expect(renamed.name).toBe(`${orgBefore.name} (renamed)`);
    expect(renamed.policyVersion).toBe(orgBefore.policyVersion);

    // Restore the shared fixtures for the cases that follow.
    await tenant.transaction(contextOf(northstarOwner), (tx) =>
      organizations.update(tx, contextOf(northstarOwner), renamed.updatedAt, {
        name: orgBefore.name,
      }),
    );
    await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.changeRole(tx, contextOf(northstarOwner), changed.id, changed.version, original),
    );
  });

  it('refuses a role change that names a stale version', async () => {
    const current = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.requireById(tx, contextOf(northstarOwner), world.northstar.manager.membershipId),
    );

    await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.changeRole(
        tx,
        contextOf(northstarOwner),
        current.id,
        current.version,
        'moderator',
      ),
    );

    await expect(
      tenant.transaction(contextOf(northstarOwner), (tx) =>
        memberships.changeRole(tx, contextOf(northstarOwner), current.id, current.version, 'guest'),
      ),
    ).rejects.toThrow(MembershipVersionConflictError);

    const after = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.requireById(tx, contextOf(northstarOwner), current.id),
    );
    expect(after.role).toBe('moderator');

    await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.changeRole(tx, contextOf(northstarOwner), current.id, after.version, 'manager'),
    );
  });

  it('suspending a membership stops that person resolving a context', async () => {
    const membership = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.requireById(tx, contextOf(northstarOwner), world.northstar.manager.membershipId),
    );

    const suspended = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.transitionStatus(
        tx,
        contextOf(northstarOwner),
        membership.id,
        membership.version,
        'suspended',
      ),
    );

    await expect(
      resolver.resolve({
        userId: world.northstar.manager.id,
        organization: { slug: 'northstar-studio' },
        correlationId: uuidv7(),
      }),
    ).rejects.toThrow(MembershipNotResolvedError);

    await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.transitionStatus(
        tx,
        contextOf(northstarOwner),
        membership.id,
        suspended.version,
        'active',
      ),
    );
  });

  it('offboarding is terminal — access is never restored by flipping the flag back', async () => {
    const invited = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.invite(tx, contextOf(northstarOwner), {
        userId: world.brightops.owner.id,
        role: 'member',
      }),
    );

    const gone = await tenant.transaction(contextOf(northstarOwner), (tx) =>
      memberships.transitionStatus(
        tx,
        contextOf(northstarOwner),
        invited.id,
        invited.version,
        'offboarded',
      ),
    );

    await expect(
      tenant.transaction(contextOf(northstarOwner), (tx) =>
        memberships.transitionStatus(
          tx,
          contextOf(northstarOwner),
          invited.id,
          gone.version,
          'active',
        ),
      ),
    ).rejects.toThrow(MembershipTransitionError);

    const unchanged = await tenant.read(contextOf(northstarOwner), (tx) =>
      memberships.requireById(tx, contextOf(northstarOwner), invited.id),
    );
    expect(unchanged.status).toBe('offboarded');

    await db.admin.execute('delete from memberships where id = ?', [invited.id]);
  });
});

describe('the principal handed to the authorization evaluator', () => {
  it('gives an internal member the projects they are a member of, and no others', async () => {
    const principal = await tenant.read(contextOf(northstarMember), (tx) =>
      principals.load(tx, northstarMember),
    );

    expect(principal.kind).toBe('internal');
    expect(principal.role).toBe('member');
    expect(principal.membershipStatus).toBe('active');
    expect(principal.hasOrgWideScope).toBe(false);
    expect(principal.projectIds).toContain(world.northstar.projectId);
    // Lina is deliberately not a member of the Brand Refresh project — same tenant,
    // different project, one of the section 11 grid cases.
    expect(principal.projectIds).not.toContain(world.northstar.otherProjectId);
    expect(principal.projectIds).not.toContain(world.twin.projectId);
  });

  it('gives an organization-wide principal an empty project list, because scope is elsewhere', async () => {
    const principal = await tenant.read(contextOf(northstarOwner), (tx) =>
      principals.load(tx, northstarOwner),
    );
    expect(principal.hasOrgWideScope).toBe(true);
    expect(principal.projectIds).toEqual([]);

    // And the evaluator reaches the same answer it would for an explicit member: scope, not
    // an empty list, is what authorises them.
    expect(
      authorize({
        principal,
        capability: 'work.read',
        resource: {
          organizationId: world.northstar.organizationId,
          projectId: world.northstar.otherProjectId,
          audience: 'internal',
        },
      }).allowed,
    ).toBe(true);
  });

  it('gives a client principal only the projects shared with their own client organization', async () => {
    const principal = await tenant.read(contextOf(atlasReviewer), (tx) =>
      principals.load(tx, atlasReviewer),
    );

    expect(principal.kind).toBe('client');
    expect(principal.clientOrganizationId).toBe(world.atlas.clientOrganizationId);
    expect(principal.projectIds).toEqual([world.northstar.projectId]);
    // Meridian is a different client of the same studio. Its project must never appear.
    expect(principal.projectIds).not.toContain(world.meridian.projectId);
  });

  it('and the evaluator refuses that principal internal content', async () => {
    const principal = await tenant.read(contextOf(atlasReviewer), (tx) =>
      principals.load(tx, atlasReviewer),
    );

    const decision = authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: world.northstar.organizationId,
        projectId: world.northstar.projectId,
        audience: 'internal',
      },
    });
    expect(decision.allowed).toBe(false);

    const acrossClients = authorize({
      principal,
      capability: 'approval.read',
      resource: {
        organizationId: world.northstar.organizationId,
        projectId: world.meridian.projectId,
        audience: 'client_visible',
        clientOrganizationId: world.meridian.clientOrganizationId,
      },
    });
    expect(acrossClients.allowed).toBe(false);
  });

  it('loads the project relation through the guarded path, not the escape hatch', async () => {
    // The bootstrap read is one read. Everything after it is ordinary and scoped, and this
    // is the assertion that keeps it that way: no guard event with an `allowedReason` is
    // emitted while the principal is being assembled.
    const before = guardEvents.length;
    await tenant.read(contextOf(northstarMember), (tx) => principals.load(tx, northstarMember));
    expect(guardEvents.slice(before)).toEqual([]);
  });
});
