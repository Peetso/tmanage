import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ClientsService } from './clients.service.js';
import type { ClientMembershipsRepository } from './client-memberships.repository.js';
import type { ClientMembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * 2026-10-31 live-test fix — the client company page lists its people by name. `withPeople` adds
 * each member's display name and email to the membership view; without it the view is unchanged.
 */

const ORG = 'org-atlas';
const context = { organizationId: ORG, userId: 'owner-1' } as unknown as TenantContext;
const AT = new Date('2026-10-01T00:00:00.000Z');

function owner(): Principal {
  return {
    userId: 'owner-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'm-owner',
    membershipStatus: 'active',
    projectIds: [],
    hasOrgWideScope: true,
  } as unknown as Principal;
}

function setup() {
  const row = {
    id: 'cm-1',
    organizationId: ORG,
    clientOrganizationId: 'co-atlas',
    userId: 'u-salma',
    role: 'client_admin',
    status: 'active',
    expiresAt: null,
    createdAt: AT,
    updatedAt: AT,
  } as ClientMembershipRow;
  const asked: string[][] = [];
  const memberships = {
    list: () => Promise.resolve([row]),
    peopleFor: (_r: never, _c: TenantContext, ids: readonly string[]) => {
      asked.push([...ids]);
      return Promise.resolve([
        { userId: 'u-salma', displayName: 'Salma Riad', email: 'salma@atlas.example' },
      ]);
    },
  } as unknown as ClientMembershipsRepository;
  const database = {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>) => work({} as never),
  } as unknown as TenantDatabase;
  const service = new ClientsService(database, { defaultExpiryDays: 30 }, undefined, memberships);
  return { service, asked };
}

describe('ClientsService.listMemberships withPeople (2026-10-31 live-test fix)', () => {
  it('adds the name and email of each member when asked', async () => {
    const { service, asked } = setup();
    const [view] = await service.listMemberships(context, owner(), {
      clientOrganizationId: 'co-atlas',
      withPeople: true,
    });
    expect(asked).toEqual([['u-salma']]);
    expect(view).toMatchObject({
      id: 'cm-1',
      displayName: 'Salma Riad',
      email: 'salma@atlas.example',
    });
  });

  it('leaves the view as it was without the flag', async () => {
    const { service, asked } = setup();
    const [view] = await service.listMemberships(context, owner(), {
      clientOrganizationId: 'co-atlas',
    });
    expect(asked).toEqual([]);
    expect(view).not.toHaveProperty('displayName');
    expect(view).not.toHaveProperty('email');
  });
});
