import { describe, expect, it, vi } from 'vitest';
import { FilesService } from './files.service.js';

/**
 * USAGE-001 slice 2, commit-path guard. `commitCompletion` writes the two completion ledger
 * rows (`commit_release`, `commit`) only when `counters.commit()` actually moved the counter.
 * A drifted reservation (`reserved_value < reservedBytes`) makes `commit()` return `false`,
 * moving neither counter column; the ledger must then record nothing so the per-counter
 * `delta` sum never leads the counter — the same invariant the release path guards with
 * `counterMoved`. This drives the private method with a fake transaction: the DB suite proves
 * the row shapes, this proves the boolean is honoured.
 */
describe('commitCompletion ledger guard honours counters.commit()', () => {
  const context = { organizationId: 'org-1' } as never;
  const session = {
    id: 'sess-1',
    declaredBytes: 100,
    fileAssetId: 'asset-1',
    partCount: 1,
    objectKey: 'objects/sess-1',
    declaredMimeType: 'application/pdf',
  } as never;
  const stored = { sizeBytes: 90, etag: 'etag-1' } as never;

  function harness(counterCommitted: boolean) {
    const ledger = { record: vi.fn().mockResolvedValue(undefined) };
    const database = {
      transaction: (_context: unknown, run: (tx: unknown) => Promise<unknown>) => run({}),
    };
    const sessions = { transition: vi.fn().mockResolvedValue({ id: 'sess-1' }) };
    const counters = { commit: vi.fn().mockResolvedValue(counterCommitted) };
    const assets = {
      transition: vi
        .fn()
        .mockResolvedValue({ id: 'asset-1', projectId: 'proj-1', purpose: 'brief' }),
      createVersion: vi.fn().mockResolvedValue({ id: 'ver-1', sizeBytes: 90 }),
    };
    const audit = { record: vi.fn().mockResolvedValue(undefined) };
    const outbox = { append: vi.fn().mockResolvedValue('event-1') };
    const service = new FilesService(
      database as never,
      sessions as never,
      assets as never,
      counters as never,
      ledger as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      outbox as never,
    );
    const commitCompletion = (
      service as unknown as {
        commitCompletion: (c: unknown, s: unknown, o: unknown) => Promise<unknown>;
      }
    ).commitCompletion.bind(service);
    return { commitCompletion, ledger };
  }

  it('writes no ledger row when the counter refuses the commit (drift)', async () => {
    const { commitCompletion, ledger } = harness(false);
    await commitCompletion(context, session, stored);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it('writes both rows when the counter did move, so the test is not vacuous', async () => {
    const { commitCompletion, ledger } = harness(true);
    await commitCompletion(context, session, stored);
    expect(ledger.record).toHaveBeenCalledTimes(2);
  });
});
