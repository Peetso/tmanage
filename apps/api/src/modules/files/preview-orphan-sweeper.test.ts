import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { FilePreviewsRepository, OrphanPreview } from './file-previews.repository.js';
import { PreviewOrphanSweeper, describeOrphanSweep } from './preview-orphan-sweeper.js';
import type { PreviewUsageMeter } from './preview-usage.js';

/** R4 follow-up — the orphan sweep against in-memory fakes: bytes first, then row and count. */
function orphan(objectKey: string | null, sizeBytes: number): OrphanPreview {
  return {
    id: uuidv7(),
    fileAssetId: uuidv7(),
    fileVersionId: uuidv7(),
    kind: 'thumb',
    objectKey,
    sizeBytes,
  };
}

describe('PreviewOrphanSweeper', () => {
  it('removes each orphan’s object then its row, gives counted bytes back, and is idempotent', async () => {
    const org = uuidv7();
    let rows = [orphan('k1', 100), orphan(null, 0), orphan('k3', 50)];
    const removed: string[] = [];
    const store = {
      remove: async ({ zone, objectKey }: { zone: string; objectKey: string }) => {
        expect(zone).toBe('derived');
        if (objectKey === 'k3') throw new Error('store refused');
        removed.push(objectKey);
      },
    } as unknown as ObjectStore;
    const previews = {
      organizationsWithOrphans: async () => (rows.length > 0 ? [org] : []),
      listOrphans: async () => [...rows],
      deleteByIds: async (_t: unknown, _c: unknown, ids: readonly string[]) => {
        const before = rows.length;
        rows = rows.filter((row) => !ids.includes(row.id));
        return before - rows.length;
      },
    } as unknown as FilePreviewsRepository;
    const usage = {
      release: vi.fn(async (_t: unknown, _c: unknown, row: OrphanPreview) =>
        (row.sizeBytes ?? 0) > 0 ? 'released' : 'not_counted',
      ),
    } as unknown as PreviewUsageMeter;
    const database = {
      bootstrapRead: (_o: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
      read: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
      transaction: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    } as unknown as TenantDatabase;
    const failures: string[] = [];
    const sweeper = new PreviewOrphanSweeper(database, previews, store, usage, undefined, (id) =>
      failures.push(id),
    );

    const report = await sweeper.sweep();
    expect(report).toMatchObject({ organizations: 1, removed: 2, releasedBytes: 100, failed: 1 });
    expect(removed).toEqual(['k1']);
    // The row whose bytes would not delete stays, for the next pass.
    expect(rows.map((row) => row.objectKey)).toEqual(['k3']);
    expect(failures).toHaveLength(1);
    expect(describeOrphanSweep(report)).toMatch(/removed 2, released 100 byte\(s\)/);
  });
});
