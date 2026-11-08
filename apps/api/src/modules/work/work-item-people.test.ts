import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { userIdList } from './work-item-people.controller.js';
import {
  doersWithLead,
  mayCompleteSupervised,
  WorkItemPeopleService,
} from './work-item-people.service.js';
import type { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** C26 — who may set the people on a task, and the owner staying the lead doer. Fakes only. */
const ORG = 'org-1';
const context = { organizationId: ORG, userId: 'u-me' } as unknown as TenantContext;
const item = {
  id: 'wi-1',
  organizationId: ORG,
  projectId: 'p-1',
  audience: 'internal',
  state: 'in_progress',
  ownerUserId: 'u-a',
  deletedAt: null,
};
const as = (role: string) =>
  ({
    userId: 'u-me',
    organizationId: ORG,
    kind: role.startsWith('client') ? 'client' : 'internal',
    role,
    membershipId: 'm-me',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: ['p-1'],
    hasOrgWideScope: false,
  }) as unknown as Principal;

function harness() {
  const writes: string[] = [];
  const db = {
    read: (_c: unknown, f: (r: unknown) => unknown) => f({}),
    transaction: (_c: unknown, f: (r: unknown) => unknown) => f({}),
  } as unknown as TenantDatabase;
  const assignees = {
    list: async () => [],
    watcherUserIds: async () => [],
    activeMemberships: async (_r: unknown, _c: unknown, ids: readonly string[]) =>
      new Map(ids.filter((id) => id !== 'u-gone').map((id) => [id, `m-${id}`])),
    replaceRole: async (
      _r: unknown,
      _c: unknown,
      _w: string,
      role: string,
      ids: readonly string[],
    ) => void writes.push(`${role}:${ids.join(',')}`),
    setLead: async (_r: unknown, _c: unknown, _w: string, lead: string | null) =>
      void writes.push(`lead:${lead}`),
  } as unknown as WorkItemAssigneesRepository;
  const workItems = { findById: async () => item } as unknown as WorkItemsRepository;
  return { writes, service: new WorkItemPeopleService(db, workItems, undefined, assignees) };
}

describe('C26 people on a task', () => {
  it('refuses a bad list, a client and a non-member, writing nothing', async () => {
    expect(() => userIdList({ userIds: 'u-a' })).toThrow();
    const { service, writes } = harness();
    await expect(
      service.setRole(context, as('client_viewer'), 'wi-1', 'doer', ['u-b']),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.setRole(context, as('member'), 'wi-1', 'supervisor', ['u-gone']),
    ).rejects.toMatchObject({ status: 422 });
    expect(writes).toEqual([]);
  });

  it('keeps the owner as the lead doer: first doer becomes owner, none clears it', async () => {
    const { service, writes } = harness();
    const view = await service.setRole(context, as('member'), 'wi-1', 'doer', [
      'u-b',
      'u-a',
      'u-b',
    ]);
    expect(view.doerUserIds[0]).toBe('u-b');
    await service.setRole(context, as('member'), 'wi-1', 'doer', []);
    expect(writes).toEqual(['doer:m-u-b,m-u-a', 'lead:u-b', 'doer:', 'lead:null']);
    expect(doersWithLead('u-a', ['u-c', 'u-a'])).toEqual(['u-a', 'u-c']);
  });

  it('C27: only a supervisor completes a supervised task; removing another watcher needs edit', async () => {
    expect(mayCompleteSupervised([], 'u-doer')).toBe(true);
    expect(mayCompleteSupervised(['u-sup'], 'u-doer')).toBe(false);
    expect(mayCompleteSupervised(['u-sup'], 'u-sup')).toBe(true);
    const { service } = harness();
    // A reader without work.update may take themselves off, never someone else (403, no write).
    const reader = {
      ...as('member'),
      overrides: { allow: [], deny: ['work.update'] },
    } as Principal;
    await expect(service.removeWatcher(context, reader, 'wi-1', 'u-other')).rejects.toMatchObject({
      status: 403,
    });
  });
});
