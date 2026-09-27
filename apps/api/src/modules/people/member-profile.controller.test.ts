import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { MemberProfileController } from './member-profile.controller.js';
import type {
  MemberProfileInput,
  MemberProfileMemberRow,
  MemberProfileRepository,
} from './member-profile.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x216 — a member's tenant-local editable profile. Database-free proofs over the module's fakes with
 * the **real** `authorize`. The properties the controller owns are unit-provable and match the
 * acceptance list: a save/read round-trips the four fields; an oversize bio or a bad email is a 400
 * with no write; a cross-tenant/unknown membership id is resolved before authorize and is a 404; a
 * principal without `org.manage` is a 403; and the write reaches only `member_profiles` — never the
 * GLOBAL `users.display_name` that blocked x192.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

function owner(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function orgAdmin(): Principal {
  // org_admin's ceiling excludes `org.manage` (capabilities.ts), so the belt-and-braces check refuses it.
  return { ...owner(), role: 'org_admin' };
}

const MEMBER: MemberProfileMemberRow = { membershipId: MEMBERSHIP, userId: USER };

function controllerWith(
  member: MemberProfileMemberRow | null,
  stored: Partial<MemberProfileInput> = {},
): { controller: MemberProfileController; upsert: ReturnType<typeof vi.fn> } {
  const upsert = vi.fn(async () => undefined);
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const service = {
    resolveMember: async () => member,
    findProfile: async () => ({
      department: stored.department ?? null,
      bio: stored.bio ?? null,
      contactEmail: stored.contactEmail ?? null,
      contactPhone: stored.contactPhone ?? null,
    }),
    upsertProfile: upsert,
  } as unknown as MemberProfileRepository;

  return { controller: new MemberProfileController(database, service), upsert };
}

describe('MemberProfileController', () => {
  it('saves then reads a member profile: the four tenant-local fields round-trip', async () => {
    const { controller, upsert } = controllerWith(MEMBER);
    const put = await controller.put(context, owner(), MEMBERSHIP, {
      department: 'Design',
      bio: 'Leads the studio brand work.',
      contactEmail: 'ada@example.com',
      contactPhone: '+1 (555) 010-2020',
    });
    expect(put).toEqual({
      membershipId: MEMBERSHIP,
      department: 'Design',
      bio: 'Leads the studio brand work.',
      contactEmail: 'ada@example.com',
      contactPhone: '+1 (555) 010-2020',
    });
    // The write reaches member_profiles with only the four fields — never users.display_name.
    expect(upsert).toHaveBeenCalledTimes(1);
    const written = upsert.mock.calls[0]?.[3] as MemberProfileInput;
    expect(Object.keys(written).sort()).toEqual([
      'bio',
      'contactEmail',
      'contactPhone',
      'department',
    ]);
    expect(written).not.toHaveProperty('displayName');

    const read = await controllerWith(MEMBER, { department: 'Design' }).controller.get(
      context,
      owner(),
      MEMBERSHIP,
    );
    expect(read.membershipId).toBe(MEMBERSHIP);
    expect(read.department).toBe('Design');
  });

  it('refuses an oversize bio or a malformed email with a 400 and writes nothing', async () => {
    const oversize = controllerWith(MEMBER);
    await expect(
      oversize.controller.put(context, owner(), MEMBERSHIP, { bio: 'x'.repeat(2001) }),
    ).rejects.toMatchObject({ status: 400 });
    expect(oversize.upsert).not.toHaveBeenCalled();

    const badEmail = controllerWith(MEMBER);
    await expect(
      badEmail.controller.put(context, owner(), MEMBERSHIP, { contactEmail: 'not-an-email' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(badEmail.upsert).not.toHaveBeenCalled();
  });

  it('answers a cross-tenant or unknown membership id with a 404, resolved before authorize', async () => {
    const { controller, upsert } = controllerWith(null);
    await expect(
      controller.put(context, owner(), 'membership-does-not-exist', { department: 'X' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      controller.get(context, owner(), 'membership-does-not-exist'),
    ).rejects.toMatchObject({ status: 404 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a principal without org.manage with a 403 and writes nothing', async () => {
    const { controller, upsert } = controllerWith(MEMBER);
    await expect(
      controller.put(context, orgAdmin(), MEMBERSHIP, { department: 'Design' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(upsert).not.toHaveBeenCalled();
    await expect(controller.get(context, orgAdmin(), MEMBERSHIP)).rejects.toMatchObject({
      status: 403,
    });
  });
});
