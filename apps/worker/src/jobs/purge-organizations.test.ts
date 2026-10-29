import { describe, expect, it, vi } from 'vitest';
import type { WorkerDatabase, WorkerTransaction } from '../common/database/worker-database.js';
import { ORGANIZATION_PURGE_HOOK, purgeOrganizations } from './purge-organizations.js';
import type { OrganizationPurgeStore } from './purge-organizations.js';
import { PURGE_HOOKS } from './purge-sweeper.js';

function fakeDatabase(): WorkerDatabase {
  const tx = { query: vi.fn() } as unknown as WorkerTransaction;
  return {
    transaction: async (work) => work(tx),
    read: async (work) => work(tx),
    end: async () => undefined,
  };
}

describe('organization purge (PA-07)', () => {
  it('registers itself once in PURGE_HOOKS', () => {
    expect(PURGE_HOOKS.filter((hook) => hook.name === 'organizations')).toEqual([
      ORGANIZATION_PURGE_HOOK,
    ]);
  });

  it('hands every due organization to erasure and counts only the ones it closed', async () => {
    const hand = vi.fn(async (_tx: WorkerTransaction, org: { id: string }) => org.id !== 'gone');
    const store: OrganizationPurgeStore = {
      listDue: async () => [
        { id: 'a', deletedByUserId: 'u1' },
        { id: 'gone', deletedByUserId: 'u1' },
        { id: 'b', deletedByUserId: 'u2' },
      ],
      hand,
    };
    await expect(purgeOrganizations(fakeDatabase(), store, 10)).resolves.toBe(2);
    expect(hand).toHaveBeenCalledTimes(3);
  });

  it('does nothing when nothing is due', async () => {
    const hand = vi.fn(async () => true);
    const store: OrganizationPurgeStore = { listDue: async () => [], hand };
    await expect(purgeOrganizations(fakeDatabase(), store)).resolves.toBe(0);
    expect(hand).not.toHaveBeenCalled();
  });
});
