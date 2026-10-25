import { describe, expect, it } from 'vitest';
import { CAPABILITIES, authorize, customRoleIdOf } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  MembershipNotResolvedError,
  MembershipResolver,
} from './membership-resolver.repository.js';
import { principalFor } from './principal.repository.js';

/**
 * L1 — an internal member whose stored role is a custom role id (Control > Roles) resolves to a
 * principal holding exactly that role's allowlisted capabilities. The custom role is read on the
 * tenant-scoped path, bound to the organization the membership row proved; an unknown or foreign id
 * (no row in this tenant) and a client membership carrying a custom id both still deny.
 */

const ORG = '0199aa00-0000-7000-8000-0000000000c1';
const USER = '0199aa00-0000-7000-8000-0000000000a1';
const MEMBERSHIP = '0199aa00-0000-7000-8000-0000000000b1';
const CLIENT_ORG = '0199aa00-0000-7000-8000-0000000000d1';
const CORRELATION = '0199aa00-0000-7000-8000-0000000000e9';
const CUSTOM_ROLE = '0199aa00-0000-7000-8000-0000000000f1';

interface Fake {
  readonly database: TenantDatabase;
  /** Every scoped read: the context it was bound to and the SQL/params it ran. */
  readonly scoped: { context: TenantContext; sql: string; params: unknown }[];
}

function fakeDatabase(options: {
  readonly internalRole?: string;
  readonly clientRole?: string;
  readonly customRows?: readonly (readonly unknown[])[];
}): Fake {
  let call = 0;
  const bootstrapRunner = {
    query: async () => {
      call += 1;
      if (call === 1) {
        return options.internalRole === undefined
          ? []
          : [[ORG, 1, MEMBERSHIP, options.internalRole, 1, 0, null, null]];
      }
      return options.clientRole === undefined
        ? []
        : [[ORG, 1, MEMBERSHIP, options.clientRole, '2026-10-18 10:00:00.000', CLIENT_ORG, null]];
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
          return options.customRows ?? [];
        },
      }),
  } as unknown as TenantDatabase;
  return { database, scoped };
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

const resourceFor = { organizationId: ORG, projectId: null, audience: 'internal' } as const;

describe('MembershipResolver — custom roles (L1)', () => {
  it('resolves a custom role with exactly its rights, read tenant-scoped', async () => {
    const fake = fakeDatabase({
      internalRole: CUSTOM_ROLE,
      customRows: [[CUSTOM_ROLE, JSON.stringify(['work.read', 'file.download', 'not.a.right'])]],
    });

    const resolved = await resolve(fake);

    expect(customRoleIdOf(resolved.role)).toBe(CUSTOM_ROLE);
    expect([...resolved.context.capabilities].sort()).toEqual(['file.download', 'work.read']);
    // One scoped read, bound to the proved organization and carrying its id as a parameter.
    expect(fake.scoped).toHaveLength(1);
    const read = fake.scoped[0];
    expect(read?.context.organizationId).toBe(ORG);
    expect(read?.context.capabilities).toEqual([]);
    expect(read?.sql.toLowerCase()).toContain('custom_roles');
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

  it('leaves a built-in role untouched, with no scoped read', async () => {
    const fake = fakeDatabase({ internalRole: 'member' });
    const resolved = await resolve(fake);
    expect(resolved.role).toBe('member');
    expect(fake.scoped).toHaveLength(0);
  });
});
