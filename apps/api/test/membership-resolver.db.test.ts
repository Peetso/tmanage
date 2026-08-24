import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { BootstrapScopeViolation } from '../src/common/database/tenant-context.js';
import type { TenantGuardEvent } from '../src/common/database/tenant-guard.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
} from '../src/modules/tenancy/membership-resolver.repository.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * The membership resolver — spec section 3 steps 2 and 3, against a real server.
 *
 * This is the one read in the system that cannot be tenant-scoped, because it is what
 * establishes the tenant. Everything else in the access layer can be checked by asking "is
 * there an `organization_id` predicate bound to the active context"; here there is no active
 * context yet, and a predicate bound to the organization the *request* named would be
 * checking the request against itself.
 *
 * So the properties under test are different from a repository's, and there are three groups:
 *
 * 1. **What resolves, and what must not.** An active internal or client membership resolves;
 *    invited, suspended, offboarded, expired, and archived-organization cases do not. This is
 *    the authorization decision that every later tenant predicate inherits — if it is wrong,
 *    every scoped query afterwards is correctly scoped to the wrong tenant.
 * 2. **What a failure discloses.** Nothing. "No such organization" and "you are not a member"
 *    are the same answer, because a distinguishable pair lets an outsider enumerate the
 *    customer base one slug at a time.
 * 3. **How narrow the escape hatch is.** The read waives ADR-0001 layer 3, so the hole it
 *    opens is measured directly: it is audited, it is read-only, and it reaches identity and
 *    membership tables only.
 *
 * The tenants are the adversarial pair — Northstar Studio and Northstar Studios, ids
 * differing in the final hex digit, slugs differing by one letter. A resolver tested against
 * obviously distinct tenants passes whether or not it is doing the comparison properly.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;
let guardEvents: TenantGuardEvent[];
let resolver: MembershipResolver;

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
});

afterAll(async () => {
  await db?.stop();
});

const resolveInternal = (userId: string, slug: string) =>
  resolver.resolve({ userId, organization: { slug }, correlationId: uuidv7() });

// ─────────────────────────────────────────────────────────────────────────────

describe('an active membership resolves into a trusted context', () => {
  it('binds the context to the organization the membership proves, not the one requested', async () => {
    const correlationId = uuidv7();
    const resolved = await resolver.resolve({
      userId: world.northstar.owner.id,
      organization: { slug: 'northstar-studio' },
      correlationId,
    });

    expect(resolved.context.organizationId).toBe(world.northstar.organizationId);
    expect(resolved.context.userId).toBe(world.northstar.owner.id);
    expect(resolved.context.membershipId).toBe(world.northstar.owner.membershipId);
    expect(resolved.context.principalKind).toBe('internal');
    expect(resolved.context.capabilities).toEqual(capabilitiesFor('owner'));
    expect(resolved.context.correlationId).toBe(correlationId);
    expect(resolved.role).toBe('owner');
    expect(resolved.clientOrganizationId).toBeNull();
    expect(resolved.hasOrgWideScope).toBe(true);
  });

  it('returns a frozen context', async () => {
    const resolved = await resolveInternal(world.northstar.owner.id, 'northstar-studio');
    expect(Object.isFrozen(resolved.context)).toBe(true);
  });

  it('accepts an organization id as well as a slug, and agrees with itself', async () => {
    const bySlug = await resolveInternal(world.northstar.manager.id, 'northstar-studio');
    const byId = await resolver.resolve({
      userId: world.northstar.manager.id,
      organization: { organizationId: world.northstar.organizationId },
      correlationId: uuidv7(),
    });

    expect(byId.context.organizationId).toBe(bySlug.context.organizationId);
    expect(byId.context.membershipId).toBe(bySlug.context.membershipId);
    expect(byId.role).toBe('manager');
    expect(byId.hasOrgWideScope).toBe(false);
  });

  it('resolves the twin’s near-identical slug to the twin', async () => {
    // 'northstar-studio' and 'northstar-studios' differ by one character, and the two
    // organization ids by one hex digit. A prefix match, a LIKE, or a trimmed comparison
    // would land on the wrong tenant here and nowhere else in the suite.
    const resolved = await resolveInternal(world.twin.owner.id, 'northstar-studios');
    expect(resolved.context.organizationId).toBe(world.twin.organizationId);
    expect(resolved.context.organizationId).not.toBe(world.northstar.organizationId);
  });

  it('resolves a client membership as an external principal carrying its client organization', async () => {
    const resolved = await resolveInternal(world.atlas.reviewer.id, 'northstar-studio');

    expect(resolved.context.principalKind).toBe('client');
    expect(resolved.context.organizationId).toBe(world.northstar.organizationId);
    expect(resolved.role).toBe('client_reviewer');
    expect(resolved.clientOrganizationId).toBe(world.atlas.clientOrganizationId);
    expect(resolved.hasOrgWideScope).toBe(false);
    expect(resolved.context.capabilities).toEqual(capabilitiesFor('client_reviewer'));
  });

  it('changes the policy version when the role changes', async () => {
    // Spec section 9 keys caches on organization plus policy version, and section 11 lists
    // "changed role after session" as a grid case. A policy version that did not move when
    // the role moved would serve the old capabilities from cache.
    const before = await resolveInternal(world.northstar.designer.id, 'northstar-studio');

    await db.admin.execute('update memberships set role = ? where id = ?', [
      'moderator',
      world.northstar.designer.membershipId,
    ]);
    const after = await resolveInternal(world.northstar.designer.id, 'northstar-studio');

    expect(after.role).toBe('moderator');
    expect(after.context.policyVersion).not.toBe(before.context.policyVersion);
    expect(after.context.capabilities).toEqual(capabilitiesFor('moderator'));

    await db.admin.execute('update memberships set role = ? where id = ?', [
      'member',
      world.northstar.designer.membershipId,
    ]);
  });
});

describe('what must not resolve', () => {
  const expectRefusal = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MembershipNotResolvedError);
    expect((error as MembershipNotResolvedError).code).toBe(code);
    return error as MembershipNotResolvedError;
  };

  it('refuses a member of another organization asking for this one', async () => {
    await expectRefusal(
      resolveInternal(world.twin.owner.id, 'northstar-studio'),
      'no_active_membership',
    );
  });

  it('refuses a suspended membership', async () => {
    await db.admin.execute('update memberships set status = ? where id = ?', [
      'suspended',
      world.northstar.manager.membershipId,
    ]);

    await expectRefusal(
      resolveInternal(world.northstar.manager.id, 'northstar-studio'),
      'no_active_membership',
    );

    await db.admin.execute('update memberships set status = ? where id = ?', [
      'active',
      world.northstar.manager.membershipId,
    ]);
    expect((await resolveInternal(world.northstar.manager.id, 'northstar-studio')).role).toBe(
      'manager',
    );
  });

  it('refuses an invited membership that has not been accepted', async () => {
    await db.admin.execute('update memberships set status = ? where id = ?', [
      'invited',
      world.northstar.manager.membershipId,
    ]);
    await expectRefusal(
      resolveInternal(world.northstar.manager.id, 'northstar-studio'),
      'no_active_membership',
    );
    await db.admin.execute('update memberships set status = ? where id = ?', [
      'active',
      world.northstar.manager.membershipId,
    ]);
  });

  it('refuses an offboarded membership', async () => {
    await db.admin.execute('update memberships set status = ? where id = ?', [
      'offboarded',
      world.northstar.manager.membershipId,
    ]);
    await expectRefusal(
      resolveInternal(world.northstar.manager.id, 'northstar-studio'),
      'no_active_membership',
    );
    await db.admin.execute('update memberships set status = ? where id = ?', [
      'active',
      world.northstar.manager.membershipId,
    ]);
  });

  it('refuses an expired client membership', async () => {
    await db.admin.execute(
      'update client_memberships set expires_at = date_sub(now(3), interval 1 day) where id = ?',
      [world.atlas.viewer.membershipId],
    );
    await expectRefusal(
      resolveInternal(world.atlas.viewer.id, 'northstar-studio'),
      'no_active_membership',
    );

    await db.admin.execute('update client_memberships set expires_at = null where id = ?', [
      world.atlas.viewer.membershipId,
    ]);
    expect((await resolveInternal(world.atlas.viewer.id, 'northstar-studio')).role).toBe(
      'client_viewer',
    );
  });

  it('refuses an archived organization', async () => {
    await db.admin.execute('update organizations set archived_at = now(3) where id = ?', [
      world.brightops.organizationId,
    ]);
    await expectRefusal(
      resolveInternal(world.brightops.owner.id, 'brightops-consulting'),
      'no_active_membership',
    );
    await db.admin.execute('update organizations set archived_at = null where id = ?', [
      world.brightops.organizationId,
    ]);
  });

  it('refuses a role the capability table does not know', async () => {
    // `memberships.role` is VARCHAR(64); the schema cannot express "one of eleven names".
    // A role nobody has defined must deny, not fall through to an empty capability set —
    // an empty set looks like a principal with no permissions rather than like a fault.
    await db.admin.execute('update memberships set role = ? where id = ?', [
      'sorcerer',
      world.northstar.manager.membershipId,
    ]);
    await expectRefusal(
      resolveInternal(world.northstar.manager.id, 'northstar-studio'),
      'role_not_recognised',
    );
    await db.admin.execute('update memberships set role = ? where id = ?', [
      'manager',
      world.northstar.manager.membershipId,
    ]);
  });

  it('refuses a client membership carrying an internal role', async () => {
    // The escalation this exists for: one bad row in `client_memberships` would otherwise
    // hand an external principal the owner capability ceiling.
    await db.admin.execute('update client_memberships set role = ? where id = ?', [
      'owner',
      world.atlas.admin.membershipId,
    ]);
    await expectRefusal(
      resolveInternal(world.atlas.admin.id, 'northstar-studio'),
      'role_not_valid_for_principal_kind',
    );
    await db.admin.execute('update client_memberships set role = ? where id = ?', [
      'client_admin',
      world.atlas.admin.membershipId,
    ]);
  });

  it('refuses an internal membership carrying a client role', async () => {
    await db.admin.execute('update memberships set role = ? where id = ?', [
      'client_admin',
      world.northstar.manager.membershipId,
    ]);
    await expectRefusal(
      resolveInternal(world.northstar.manager.id, 'northstar-studio'),
      'role_not_valid_for_principal_kind',
    );
    await db.admin.execute('update memberships set role = ? where id = ?', [
      'manager',
      world.northstar.manager.membershipId,
    ]);
  });

  it('refuses when one person holds both an internal and a client membership', async () => {
    // Picking one silently is the tempting behaviour and the wrong one in both directions:
    // preferring internal escalates whoever was added to the wrong table, preferring client
    // demotes staff. Neither failure announces itself. Refusing does.
    const id = uuidv7();
    await db.admin.execute(
      `insert into memberships (id, organization_id, user_id, role, has_org_wide_scope)
       values (?, ?, ?, 'member', 0)`,
      [id, world.northstar.organizationId, world.atlas.reviewer.id],
    );

    await expectRefusal(
      resolveInternal(world.atlas.reviewer.id, 'northstar-studio'),
      'principal_kind_ambiguous',
    );

    await db.admin.execute('delete from memberships where id = ?', [id]);
  });
});

describe('a refusal discloses nothing about which organizations exist', () => {
  const refusalOf = async (promise: Promise<unknown>): Promise<MembershipNotResolvedError> => {
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MembershipNotResolvedError);
    return error as MembershipNotResolvedError;
  };

  it('answers an unknown slug exactly as it answers a real one the caller cannot reach', async () => {
    const unknown = await refusalOf(resolveInternal(world.northstar.owner.id, 'no-such-studio'));
    const notAMember = await refusalOf(
      resolveInternal(world.northstar.owner.id, 'brightops-consulting'),
    );

    expect(unknown.message).toBe(notAMember.message);
    expect(unknown.code).toBe(notAMember.code);
    // And neither carries the identifier of an organization the caller cannot see.
    expect(notAMember.message).not.toContain(world.brightops.organizationId);
  });
});

describe('the escape hatch is audited, read-only, and reaches nothing else', () => {
  it('records a security event naming the reason, exactly like the outbox relay', async () => {
    const before = guardEvents.length;
    await resolveInternal(world.northstar.owner.id, 'northstar-studio');
    const emitted = guardEvents.slice(before);

    expect(emitted.length).toBeGreaterThan(0);
    for (const event of emitted) {
      expect(event.allowedReason).toMatch(/membership/i);
      expect(event.tenantTables.length).toBeGreaterThan(0);
      // The event is logged in production, so it must carry no tenant data — the shape has
      // literals collapsed and parameters left as `?`.
      expect(event.shape).not.toContain(world.northstar.owner.id);
      expect(event.shape).not.toContain('northstar-studio');
    }
  });

  it('and the same statements are genuinely unscopeable — they are refused without it', async () => {
    // The escape is only defensible if the read really cannot carry a tenant predicate.
    // Issued through the ordinary guarded path, the resolver's own lookup is rejected.
    const context = (await resolveInternal(world.northstar.owner.id, 'northstar-studio')).context;
    await expect(
      tenant.read(context, (tx) =>
        tx.query('select id from organizations where slug = ?', ['northstar-studio']),
      ),
    ).rejects.toThrow(/no organization_id predicate/);
  });

  it('refuses a bootstrap read that reaches a table outside the declared allowlist', async () => {
    await expect(
      tenant.bootstrapRead(
        {
          correlationId: uuidv7(),
          reason: 'membership resolution for a verified session (TEN-001)',
          tables: ['organizations', 'memberships'],
        },
        (tx) => tx.query('select id from projects'),
      ),
    ).rejects.toThrow(BootstrapScopeViolation);
  });

  it('counts a tenant table the analyser could not place, not only the ones it understood', async () => {
    // `projects` here is not introduced by FROM, JOIN, UPDATE or INTO, so the guard's
    // reference scanner does not register it as a table — it records "appears in a position
    // this guard cannot analyse" instead, and that violation is exactly what the escape
    // hatch suppresses. The allowlist therefore cannot be built from the analyser's
    // understood-table list; it has to count every tenant table name that survives
    // tokenization, or an unparseable statement would slip past the check that exists
    // *because* the tenant predicate has been waived.
    await expect(
      tenant.bootstrapRead(
        {
          correlationId: uuidv7(),
          reason: 'membership resolution for a verified session (TEN-001)',
          tables: ['organizations'],
        },
        (tx) => tx.query('select projects.id from organizations where id is not null'),
      ),
    ).rejects.toThrow(BootstrapScopeViolation);
  });

  it('refuses a bootstrap write even inside the allowlist', async () => {
    await expect(
      tenant.bootstrapRead(
        {
          correlationId: uuidv7(),
          reason: 'membership resolution for a verified session (TEN-001)',
          tables: ['memberships'],
        },
        (tx) =>
          tx.query('update memberships set role = ? where id = ?', [
            'owner',
            world.northstar.designer.membershipId,
          ]),
      ),
    ).rejects.toThrow(BootstrapScopeViolation);

    const [rows] = await db.admin.query<RowDataPacket[]>(
      'select role from memberships where id = ?',
      [world.northstar.designer.membershipId],
    );
    expect(rows[0]?.['role']).toBe('member');
  });

  it('refuses an allowlist naming something that is not a tenant table', async () => {
    // A typo in the allowlist would widen it rather than narrow it: a name matching no
    // tenant table constrains nothing, so every real table would fall outside it and the
    // check would be inert. Caught when the runner is built, not when a statement runs.
    await expect(
      tenant.bootstrapRead(
        {
          correlationId: uuidv7(),
          reason: 'membership resolution for a verified session (TEN-001)',
          tables: ['organisations'],
        },
        (tx) => tx.query('select 1 as one'),
      ),
    ).rejects.toThrow(BootstrapScopeViolation);
  });

  it('rejects a reason string too thin to be worth auditing', async () => {
    await expect(
      tenant.bootstrapRead(
        { correlationId: uuidv7(), reason: 'needed', tables: ['organizations'] },
        (tx) => tx.query('select id from organizations'),
      ),
    ).rejects.toThrow(TypeError);
  });
});
