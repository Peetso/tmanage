import { beforeEach, describe, expect, it } from 'vitest';
import { CAPABILITIES, authorize, customRoleIdOf } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
  ORGANIZATION_DELETED_AT,
} from './membership-resolver.repository.js';
import { principalFor } from './principal.repository.js';

/**
 * L1 — an internal member whose stored role is a custom role id (Control > Roles) resolves to a
 * principal holding exactly that role's allowlisted capabilities. The custom role is read on the
 * tenant-scoped path, bound to the organization the membership row proved; an unknown or foreign id
 * (no row in this tenant) and a client membership carrying a custom id both still deny.
 *
 * PA-01 — the same resolver loads the member's live overrides, accepts the hidden
 * `platform_support` role only while its Support session is live, and refuses a deleted
 * organization once 0243 has added `organizations.deleted_at`.
 */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const USER = '0199aa00-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0199aa00-0000-7000-8000-0000000000b1';
const CLIENT_ORG = '0199aa00-0000-7000-8000-0000000000d1';
const CORRELATION = '0199aa00-0000-7000-8000-0000000000e9';
const CUSTOM_ROLE = '0199aa00-0000-7000-8000-0000000000f1';
const SESSION = '0199aa00-0000-7000-8000-0000000000aa';

interface Fake {
  readonly database: TenantDatabase;
  /** Every scoped read: the context it was bound to and the SQL/params it ran. */
  readonly scoped: { context: TenantContext; sql: string; params: unknown }[];
  /** Every bootstrap statement, in order. */
  readonly bootstrap: { sql: string; params: unknown }[];
}

function fakeDatabase(options: {
  readonly internalRole?: string;
  readonly clientRole?: string;
  readonly customRows?: readonly (readonly unknown[])[];
  /** Positional `[capability, effect]` rows the overrides read returns. */
  readonly overrideRows?: readonly (readonly unknown[])[];
  /** Object rows the live-session read returns. */
  readonly sessionRows?: readonly Record<string, unknown>[];
  /** `organizations.deleted_at` for the matched row, when the column is present. */
  readonly deletedAt?: string | null;
  /** The probe for the 0243 column fails with "unknown column". */
  readonly deletedAtMissing?: boolean;
}): Fake {
  const bootstrap: Fake['bootstrap'] = [];
  const deletedAt = (): unknown[] =>
    ORGANIZATION_DELETED_AT.state === 'present' ? [options.deletedAt ?? null] : [];
  const bootstrapRunner = {
    query: async (sql: string, params: unknown) => {
      bootstrap.push({ sql, params });
      const text = sql.toLowerCase();
      if (text.includes('limit 0')) {
        if (options.deletedAtMissing) {
          throw Object.assign(new Error("Unknown column 'deleted_at'"), { errno: 1054 });
        }
        return [];
      }
      if (text.includes('platform_support_sessions')) return options.sessionRows ?? [];
      if (text.includes('from `memberships` inner join `client_memberships`')) return [];
      if (text.includes('inner join `client_memberships`')) {
        return options.clientRole === undefined
          ? []
          : [
              [
                ORG,
                1,
                MEMBERSHIP,
                options.clientRole,
                '2026-10-18 10:00:00.000',
                CLIENT_ORG,
                null,
                ...deletedAt(),
              ],
            ];
      }
      return options.internalRole === undefined
        ? []
        : [[ORG, 1, MEMBERSHIP, options.internalRole, 1, 0, null, null, ...deletedAt()]];
    },
  };
  const scoped: Fake['scoped'] = [];
  const database = {
    bootstrapRead: async <T>(_o: unknown, work: (db: unknown) => Promise<T>) =>
      work(bootstrapRunner),
    read: async <T>(context: TenantContext, work: (db: unknown) => Promise<T>) =>
      work({
        query: async (sql: string, params: unknown) => {
          scoped.push({ context, sql, params });
          if (sql.includes('membership_permission_overrides')) return options.overrideRows ?? [];
          return options.customRows ?? [];
        },
      }),
  } as unknown as TenantDatabase;
  return { database, scoped, bootstrap };
}

function resolve(fake: Fake) {
  return new MembershipResolver(fake.database).resolve({
    userId: USER,
    organization: { slug: 'northstar' },
    correlationId: CORRELATION,
  });
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MembershipNotResolvedError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

const customReads = (fake: Fake) => fake.scoped.filter((read) => read.sql.includes('custom_roles'));

const resourceFor = { organizationId: ORG, projectId: null, audience: 'internal' } as const;

beforeEach(() => {
  // Most cases run as on today's schema (no 0243 column); the deleted-org cases opt in.
  ORGANIZATION_DELETED_AT.state = 'absent';
});

describe('MembershipResolver — custom roles (L1)', () => {
  it('resolves a custom role with exactly its rights, read tenant-scoped', async () => {
    const fake = fakeDatabase({
      internalRole: CUSTOM_ROLE,
      customRows: [[CUSTOM_ROLE, JSON.stringify(['work.read', 'file.download', 'not.a.right'])]],
    });

    const resolved = await resolve(fake);

    expect(customRoleIdOf(resolved.role)).toBe(CUSTOM_ROLE);
    expect([...resolved.context.capabilities].sort()).toEqual(['file.download', 'work.read']);
    // One custom-role read, bound to the proved organization and carrying its id as a parameter.
    expect(customReads(fake)).toHaveLength(1);
    const read = customReads(fake)[0];
    expect(read?.context.organizationId).toBe(ORG);
    expect(read?.context.capabilities).toEqual([]);
    expect(read?.sql.toLowerCase()).toContain('organization_id');
    expect(JSON.stringify(read?.params)).toContain(ORG);
    expect(JSON.stringify(read?.params)).toContain(CUSTOM_ROLE);
  });

  it('accepts an upper-case stored id for the same role', async () => {
    const fake = fakeDatabase({
      internalRole: CUSTOM_ROLE.toUpperCase(),
      customRows: [[CUSTOM_ROLE, JSON.stringify(['work.read'])]],
    });
    const resolved = await resolve(fake);
    expect(resolved.context.capabilities).toEqual(['work.read']);
  });

  it('denies an unknown or foreign custom role id (no row in this tenant)', async () => {
    const fake = fakeDatabase({ internalRole: CUSTOM_ROLE, customRows: [] });
    expect(await refusal(resolve(fake))).toBe('role_not_recognised');
  });

  it('denies a stored role that is neither a built-in name nor a custom role id', async () => {
    const fake = fakeDatabase({ internalRole: 'superuser' });
    expect(await refusal(resolve(fake))).toBe('role_not_recognised');
    expect(fake.scoped).toHaveLength(0);
  });

  it('still refuses a client membership carrying a custom role id', async () => {
    const fake = fakeDatabase({
      clientRole: CUSTOM_ROLE,
      customRows: [[CUSTOM_ROLE, JSON.stringify(['client_projection.read'])]],
    });
    expect(await refusal(resolve(fake))).toBe('role_not_recognised');
    expect(fake.scoped).toHaveLength(0);
  });

  it('a custom role holding the member-management right (org.manage) can do that and nothing more', async () => {
    const fake = fakeDatabase({
      internalRole: CUSTOM_ROLE,
      customRows: [[CUSTOM_ROLE, JSON.stringify(['org.manage'])]],
    });
    const resolved = await resolve(fake);
    const principal = principalFor(resolved, []);

    const allowed = CAPABILITIES.filter(
      (capability: Capability) =>
        authorize({ principal, capability, resource: resourceFor }).allowed,
    );
    expect(allowed).toEqual(['org.manage']);
  });

  it('leaves a built-in role untouched, with no custom-role read', async () => {
    const fake = fakeDatabase({ internalRole: 'member' });
    const resolved = await resolve(fake);
    expect(resolved.role).toBe('member');
    expect(customReads(fake)).toHaveLength(0);
  });
});

describe('MembershipResolver — overrides (PA-01)', () => {
  it('loads the live overrides tenant-scoped and puts them on the principal', async () => {
    const fake = fakeDatabase({
      internalRole: 'member',
      overrideRows: [
        ['work.delete', 'allow'],
        ['conversation.write', 'deny'],
        ['not.a.right', 'allow'],
      ],
    });
    const resolved = await resolve(fake);

    expect(resolved.overrides).toEqual({ allow: ['work.delete'], deny: ['conversation.write'] });
    const read = fake.scoped.find((r) => r.sql.includes('membership_permission_overrides'));
    expect(read?.context.organizationId).toBe(ORG);
    expect(read?.sql).toContain('revoked_at');
    expect(read?.sql).toContain('expires_at');
    expect(JSON.stringify(read?.params)).toContain(MEMBERSHIP);

    // The context's capability list is the effective set: role ∪ allow − deny.
    expect(resolved.context.capabilities).toContain('work.delete');
    expect(resolved.context.capabilities).not.toContain('conversation.write');

    const principal = principalFor(resolved, []);
    expect(principal.overrides).toEqual(resolved.overrides);
    expect(
      authorize({ principal, capability: 'conversation.write', resource: resourceFor }),
    ).toMatchObject({ allowed: false, code: 'capability_denied_by_override' });
    expect(authorize({ principal, capability: 'work.delete', resource: resourceFor }).allowed).toBe(
      true,
    );
  });

  it('resolves with empty overrides when the member has none', async () => {
    const resolved = await resolve(fakeDatabase({ internalRole: 'manager' }));
    expect(resolved.overrides).toEqual({ allow: [], deny: [] });
    expect(resolved.supportSession).toBeNull();
  });
});

describe('MembershipResolver — platform_support (PA-01, SPEC §3.2)', () => {
  const live = {
    id: SESSION,
    admin_user_id: USER,
    expires_at: new Date('2026-10-28T12:00:00.000Z'),
  };

  it('resolves while the Support session is live, org-wide, with the session attached', async () => {
    const fake = fakeDatabase({ internalRole: 'platform_support', sessionRows: [live] });
    const resolved = await resolve(fake);

    expect(resolved.role).toBe('platform_support');
    expect(resolved.hasOrgWideScope).toBe(true);
    expect(resolved.supportSession).toEqual({
      id: SESSION,
      adminUserId: USER,
      expiresAt: live.expires_at,
    });
    expect(resolved.context.capabilities).toEqual([...CAPABILITIES]);
    const read = fake.bootstrap.find((s) => s.sql.includes('platform_support_sessions'));
    expect(read?.sql).toContain('ended_at IS NULL');
    expect(read?.sql).toContain('expires_at > now(3)');
    expect(read?.params).toEqual([ORG, MEMBERSHIP, USER]);
  });

  it('refuses once the session has expired or ended (no live row)', async () => {
    const fake = fakeDatabase({ internalRole: 'platform_support', sessionRows: [] });
    expect(await refusal(resolve(fake))).toBe('no_active_membership');
  });

  it('a deny override never narrows the Support-session role', async () => {
    const fake = fakeDatabase({
      internalRole: 'platform_support',
      sessionRows: [live],
      overrideRows: [['org.manage', 'deny']],
    });
    const resolved = await resolve(fake);
    expect(resolved.context.capabilities).toContain('org.manage');
    const principal = principalFor(resolved, []);
    expect(authorize({ principal, capability: 'org.manage', resource: resourceFor }).allowed).toBe(
      true,
    );
  });

  it('never reads a session for an ordinary role', async () => {
    const fake = fakeDatabase({ internalRole: 'owner' });
    await resolve(fake);
    expect(fake.bootstrap.some((s) => s.sql.includes('platform_support_sessions'))).toBe(false);
  });
});

describe('MembershipResolver — deleted organization (PA-01, 0243)', () => {
  it('refuses a proved member of a deleted organization with organization_closed', async () => {
    ORGANIZATION_DELETED_AT.state = 'present';
    const fake = fakeDatabase({ internalRole: 'owner', deletedAt: '2026-10-27 09:00:00.000' });
    expect(await refusal(resolve(fake))).toBe('organization_closed');
  });

  it('refuses a client member of a deleted organization the same way', async () => {
    ORGANIZATION_DELETED_AT.state = 'present';
    const fake = fakeDatabase({ clientRole: 'client_admin', deletedAt: '2026-10-27 09:00:00.000' });
    expect(await refusal(resolve(fake))).toBe('organization_closed');
  });

  it('resolves a member of a live organization when the column is present', async () => {
    ORGANIZATION_DELETED_AT.state = 'present';
    const resolved = await resolve(fakeDatabase({ internalRole: 'owner', deletedAt: null }));
    expect(resolved.role).toBe('owner');
  });

  it('probes once, and reads nothing extra while 0243 is not applied', async () => {
    ORGANIZATION_DELETED_AT.reset();
    const fake = fakeDatabase({ internalRole: 'owner', deletedAtMissing: true });
    const resolved = await resolve(fake);
    expect(resolved.role).toBe('owner');
    expect(ORGANIZATION_DELETED_AT.state).toBe('absent');
    expect(fake.bootstrap.filter((s) => s.sql.includes('LIMIT 0'))).toHaveLength(1);
    await resolve(fake);
    expect(fake.bootstrap.filter((s) => s.sql.includes('LIMIT 0'))).toHaveLength(1);
    expect(
      fake.bootstrap.some((s) => s.sql.includes('deleted_at') && !s.sql.includes('LIMIT 0')),
    ).toBe(false);
  });
});
