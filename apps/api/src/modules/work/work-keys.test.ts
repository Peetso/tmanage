import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { type ApiError } from '../../common/http/errors.js';
import { WorkKeysService } from './work-keys.service.js';
import type { WorkKeysRepository } from './work-keys.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** R16-e — prefix backfill uses one monotonic counter; clients never reach code links. */
const context = { organizationId: 'org-1', userId: 'u-1' } as unknown as TenantContext;
const run = (_c: unknown, work: (r: never) => unknown) => work({} as never);
const db = { read: run, transaction: run } as unknown as TenantDatabase;
const member = {
  userId: 'u-1',
  organizationId: 'org-1',
  kind: 'internal',
  role: 'owner',
  membershipId: 'm-1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: ['p-1'],
  hasOrgWideScope: true,
} as Principal;
const item = {
  id: 'wi-1',
  organizationId: 'org-1',
  projectId: 'p-1',
  audience: 'client_visible',
  state: 'todo',
  deletedAt: null,
};

describe('work keys (R16-e)', () => {
  it('backfills in created order from one counter, never reusing a number', async () => {
    let next = 1;
    const keyed: string[] = [];
    const unkeyed = ['a', 'b', 'c'];
    const keys = {
      findProject: () =>
        Promise.resolve({ id: 'p-1', archivedAt: null, workKeyPrefix: null, workKeyNext: next }),
      projectWithPrefix: () => Promise.resolve(null),
      setPrefix: () => Promise.resolve(),
      unkeyedItems: () => Promise.resolve(unkeyed.splice(0, 2)),
      reserve: (_r: never, _c: never, _p: string, n: number) => Promise.resolve((next += n) - n),
      setWorkKey: (_r: never, _c: never, id: string, key: string) =>
        Promise.resolve(void keyed.push(`${id}=${key}`)),
    } as unknown as WorkKeysRepository;
    const service = new WorkKeysService(db, {} as never, keys, {
      audit: { append: () => Promise.resolve({}) } as never,
    });
    expect((await service.setPrefix(context, member, 'p-1', ' tm ')).prefix).toBe('TM');
    await service.backfill(context, 'p-1', 'TM'); // an idempotent re-run keys nothing twice
    expect(keyed).toEqual(['a=TM-1', 'b=TM-2', 'c=TM-3']);
  });

  it('answers a client principal 404 even on a client-visible item', async () => {
    const workItems = { findById: () => Promise.resolve(item) } as unknown as WorkItemsRepository;
    const service = new WorkKeysService(db, workItems, {} as never, { audit: {} as never });
    const client = {
      ...member,
      kind: 'client',
      role: 'client',
      clientOrganizationId: 'co-1',
    } as Principal;
    const status = await service
      .listLinks(context, client, 'wi-1')
      .catch((e: ApiError) => e.status);
    expect(status).toBe(404);
  });
});
