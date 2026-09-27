import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { SavedSearchSharesController } from './saved-search-shares.controller.js';
import { SavedSearchSharesService } from './saved-search-shares.service.js';
import type { SavedSearchSharesRepository } from './saved-search-shares.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * SRCH saved-search sharing (x272). Database-free proofs of the two authorization spines: the route
 * ceiling is `search.use` (a caller without it is the guard's 403), and share/unshare resolve the
 * saved search before authorizing — an unknown id is a 404 and only the owner may act (a non-owner
 * is a 403 with **no write**). The DB predicates themselves are the chain's `.db.test.ts`.
 */

const OWNER = 'user-0000-0000-0000-0000-000000000001';
const OTHER = 'user-0000-0000-0000-0000-000000000002';
const context = {
  organizationId: 'organization-0000-0000-0000-000000000001',
  userId: OTHER,
  membershipId: 'membership-0000-0000-0000-000000000002',
} as TenantContext;

/** A service over a fake database that runs the work with a stub runner, and the given repository. */
function serviceWith(repository: Partial<SavedSearchSharesRepository>): SavedSearchSharesService {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new SavedSearchSharesService(database, repository as SavedSearchSharesRepository);
}

describe('SavedSearchSharesController capability wiring', () => {
  it('gates every route on search.use (the 403 for a caller without it is the guard’s)', () => {
    const reflector = new Reflector();
    for (const handler of [
      SavedSearchSharesController.prototype.listShared,
      SavedSearchSharesController.prototype.share,
      SavedSearchSharesController.prototype.unshare,
    ]) {
      expect(reflector.get(REQUIRED_CAPABILITY, handler)).toBe('search.use');
    }
  });
});

describe('SavedSearchSharesService owner scope', () => {
  it('refuses to share another member’s saved search with a 403 and does NOT insert', async () => {
    const insertShareIfAbsent = vi.fn(async () => {});
    const service = serviceWith({
      // The saved search resolves, but it is owned by someone other than the caller.
      resolveOwner: async () => OWNER,
      insertShareIfAbsent,
    });
    await expect(service.share(context, 'not-mine')).rejects.toMatchObject({ status: 403 });
    expect(insertShareIfAbsent).not.toHaveBeenCalled();
  });

  it('answers 404 (not 403) when the saved search does not exist, and does NOT insert', async () => {
    const insertShareIfAbsent = vi.fn(async () => {});
    const service = serviceWith({ resolveOwner: async () => undefined, insertShareIfAbsent });
    await expect(service.share(context, 'ghost')).rejects.toMatchObject({ status: 404 });
    expect(insertShareIfAbsent).not.toHaveBeenCalled();
  });

  it('refuses to unshare another member’s saved search with a 403 and does NOT delete', async () => {
    const deleteShare = vi.fn(async () => true);
    const service = serviceWith({ resolveOwner: async () => OWNER, deleteShare });
    await expect(service.unshare(context, 'not-mine')).rejects.toMatchObject({ status: 403 });
    expect(deleteShare).not.toHaveBeenCalled();
  });

  it('shares (idempotently) and returns the shared list when the caller is the owner', async () => {
    const insertShareIfAbsent = vi.fn(async () => {});
    const service = serviceWith({
      resolveOwner: async () => context.userId,
      insertShareIfAbsent,
      listShared: async () => [
        {
          id: 'saved-1',
          name: 'Team open work',
          queryText: 'open',
          filters: [],
          ownerUserId: context.userId,
          sharedAt: new Date('2026-03-01T09:00:00.000Z'),
        },
      ],
    });
    const shared = await service.share(context, 'saved-1');
    expect(insertShareIfAbsent).toHaveBeenCalledOnce();
    expect(shared).toEqual([
      {
        id: 'saved-1',
        name: 'Team open work',
        query: 'open',
        filters: [],
        ownerUserId: context.userId,
        sharedAt: '2026-03-01T09:00:00.000Z',
      },
    ]);
  });
});
