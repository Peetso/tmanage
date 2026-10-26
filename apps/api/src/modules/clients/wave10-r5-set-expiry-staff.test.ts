import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ClientsService } from './clients.service.js';
import type { ClientMembershipsRepository } from './client-memberships.repository.js';
import type { ClientOrganizationsRepository } from './client-organizations.repository.js';
import type { ClientMembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * Wave 10 R5 — F27 variant 2: `setExpiry` on an active-but-expired client row revives it. When that
 * person has since become staff in this tenant, the revived row collided with their internal
 * membership and the resolver locked them out of the whole tenant. Now the extension is refused with
 * the same neutral refusal `changeStatus` gives (404 `user_is_internal_member`), and nothing changes.
 */

const ORG = 'org-atlas';
const CLIENT_A = 'client-org-a';
const STAFF_USER = 'now-staff-user';
const OUTSIDE_USER = 'outside-user';
const context = { organizationId: ORG, userId: 'caller-1' } as unknown as TenantContext;
const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000);

function clientAdmin(): Principal {
  return {
    userId: 'client-admin-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'cm-admin-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_A,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

function setup(userId: string) {
  const row: ClientMembershipRow = {
    id: 'cm-1',
    organizationId: ORG,
    clientOrganizationId: CLIENT_A,
    userId,
    role: 'client_viewer',
    status: 'active',
    expiresAt: PAST,
    createdAt: PAST,
    updatedAt: PAST,
  } as ClientMembershipRow;
  const writes: unknown[] = [];
  const memberships = {
    userHasActiveInternalMembership: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(id === STAFF_USER),
    findById: () => Promise.resolve({ ...row }),
    setExpiry: (_r: never, _c: TenantContext, id: string, _at: Date, expiresAt: Date | null) => {
      writes.push({ id, expiresAt });
      row.expiresAt = expiresAt;
      return Promise.resolve({ ...row });
    },
  } as unknown as ClientMembershipsRepository;
  const organizations = {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve({ id, organizationId: ORG, archivedAt: null } as never),
  } as unknown as ClientOrganizationsRepository;
  const service = new ClientsService(
    fakeDatabase(),
    { defaultExpiryDays: 30 },
    organizations,
    memberships,
  );
  return { service, row, writes };
}

describe('wave 10 R5 — F27b: setExpiry never revives a client row for someone now staff', () => {
  it('refuses a client admin extending the expired row of a now-staff user; nothing changes', async () => {
    const { service, row, writes } = setup(STAFF_USER);
    await expect(
      service.setExpiry(context, clientAdmin(), 'cm-1', PAST, FUTURE),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(writes).toHaveLength(0);
    expect(row.expiresAt).toEqual(PAST);
  });

  it('refuses making it open-ended (null) as well', async () => {
    const { service, writes } = setup(STAFF_USER);
    await expect(
      service.setExpiry(context, clientAdmin(), 'cm-1', PAST, null),
    ).rejects.toMatchObject({ status: 404 });
    expect(writes).toHaveLength(0);
  });

  it('still lets the client admin extend the row of a non-staff colleague', async () => {
    const { service, writes } = setup(OUTSIDE_USER);
    const view = await service.setExpiry(context, clientAdmin(), 'cm-1', PAST, FUTURE);
    expect(writes).toHaveLength(1);
    expect(view.id).toBe('cm-1');
  });

  it('still lets a staff-held row be shortened into the past (it stays dead)', async () => {
    const { service, writes } = setup(STAFF_USER);
    await service.setExpiry(context, clientAdmin(), 'cm-1', PAST, new Date('2021-01-01T00:00:00Z'));
    expect(writes).toHaveLength(1);
  });
});
