import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { uploadStateMachine } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { EICAR, NoneScanner, StubScanner } from '../../common/scan/malware-scanner.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { FileBlockNotifier, fileBlockedDedupeKey } from './file-block-notifier.js';
import { FileRescanner } from './file-rescanner.js';
import { FileScanJob } from './file-scan-job.js';
import { FileScanner } from './file-scanner.js';

/**
 * QA-FIX S1 (security pass 2026-11-20): "19-eicar.txt" was cleared by the signatures of its day
 * and stayed "Virus-scanned", downloadable and shareable, because nothing ever looked at a
 * `ready` file again. These tests hold the re-check pass to: a clean file whose bytes a newer
 * signature set detects is blocked (`ready → rejected`, `malware_detected`), its private copy is
 * withdrawn, the uploader is told and the audit says it was a re-check; a file that is still clean
 * only moves its checked-signature number forward; nothing runs without a real engine version.
 */

const ORG = '01a1f7c3-0000-7000-8000-000000000001';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

interface Stored {
  asset: FileAssetRow;
  version: FileVersionRow;
  bytes: Buffer;
}

function stored(id: string, bytes: Buffer, checked: number | null): Stored {
  return {
    asset: {
      id,
      organizationId: ORG,
      projectId: 'project-1',
      ownerUserId: 'uploader-1',
      purpose: 'attachment',
      objectId: null,
      status: 'ready',
    } as unknown as FileAssetRow,
    version: {
      id: `${id}-v1`,
      fileAssetId: id,
      objectKey: `${ORG}/${id}/v1`,
      sizeBytes: bytes.length,
      contentHash: sha(bytes),
      scanVerdict: 'clean',
      trustZone: 'private',
      checkedSignatureVersion: checked,
    } as unknown as FileVersionRow,
    bytes,
  };
}

function harness(
  files: Stored[],
  scanner = new StubScanner(2),
  budget?: { files: number; bytes: number },
) {
  const withdrawn: string[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const events: string[] = [];
  const notified: { recipientUserId: string; type: string; dedupeKey: string }[] = [];
  const rechecks: { id: string; signature: number }[] = [];
  const failures: unknown[] = [];

  const assets = {
    organizationsAwaitingRecheck: async (_db: unknown, signature: number) =>
      files.some((f) => stale(f, signature)) ? [ORG] : [],
    listAwaitingRecheck: async (_db: unknown, _ctx: unknown, signature: number, limit: number) =>
      files
        .filter((f) => stale(f, signature))
        .slice(0, limit)
        .map((f) => ({ asset: f.asset, version: f.version })),
    recordRecheck: async (_tx: unknown, _ctx: unknown, id: string, signature: number) => {
      rechecks.push({ id, signature });
      const file = files.find((f) => f.version.id === id);
      if (file) file.version = { ...file.version, checkedSignatureVersion: signature };
      return true;
    },
    // The real machine decides: before QA-FIX S1 `ready → rejected` was not a legal move.
    transition: async (
      _tx: unknown,
      _ctx: unknown,
      id: string,
      to: 'rejected',
      facts: Record<string, unknown>,
    ) => {
      const file = files.find((f) => f.asset.id === id)!;
      const verdict = uploadStateMachine.transition(file.asset.status as 'ready', to, facts);
      if (!verdict.ok) throw new Error(verdict.detail);
      file.asset = {
        ...file.asset,
        status: to,
        rejectionCode: facts['rejectionCode'],
      } as FileAssetRow;
      return file.asset;
    },
  } as unknown as FileAssetsRepository;

  const store = {
    openObject: async ({ zone, objectKey }: { zone: string; objectKey: string }) => {
      expect(zone).toBe('private');
      const file = files.find((f) => f.version.objectKey === objectKey)!;
      return { sizeBytes: file.bytes.length, stream: Readable.from([file.bytes]) };
    },
    withdraw: async ({ objectKey }: { objectKey: string }) => {
      withdrawn.push(objectKey);
    },
  } as unknown as ObjectStore;

  const database = {
    bootstrapRead: async (_meta: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    read: async (_ctx: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const audit = {
    record: async (
      _tx: unknown,
      _ctx: unknown,
      row: { action: string; metadata: Record<string, unknown> },
    ) => {
      audits.push({ action: row.action, metadata: row.metadata });
    },
  } as unknown as AuditService;
  const outbox = {
    append: async (_tx: unknown, _ctx: unknown, event: { type: string }) => {
      events.push(event.type);
    },
  } as unknown as OutboxEventsRepository;
  const notifier = new FileBlockNotifier({
    insertForRecipient: async (_tx, _ctx, input) => {
      notified.push(input);
    },
  });

  const rescanner = new FileRescanner(
    database,
    assets,
    store,
    scanner,
    audit,
    outbox,
    notifier,
    () => new Date('2026-11-20T12:00:00Z'),
    budget,
    (_id, error) => failures.push(error),
    () => undefined,
  );
  return { rescanner, files, withdrawn, audits, events, notified, rechecks, failures };
}

function stale(file: Stored, signature: number): boolean {
  const checked = file.version.checkedSignatureVersion;
  return file.asset.status === 'ready' && (checked === null || checked < signature);
}

describe('FileRescanner (QA-FIX S1)', () => {
  it('blocks a file an older signature set cleared, withdraws it, tells the uploader and audits a re-check', async () => {
    const eicar = stored('eicar-1', EICAR, null);
    const t = harness([eicar]);

    const report = await t.rescanner.rescan();

    expect(t.failures).toEqual([]);
    expect(report).toMatchObject({ signatureVersion: 2, checked: 1, blocked: 1, stillClean: 0 });
    expect(eicar.asset.status).toBe('rejected');
    expect(eicar.asset.rejectionCode).toBe('malware_detected');
    expect(t.withdrawn).toEqual([`${ORG}/eicar-1/v1`]);
    expect(t.notified).toEqual([
      expect.objectContaining({
        recipientUserId: 'uploader-1',
        type: 'file.blocked.v1',
        dedupeKey: fileBlockedDedupeKey('eicar-1'),
      }),
    ]);
    expect(t.audits).toEqual([
      expect.objectContaining({
        action: 'file_asset.rejected',
        metadata: expect.objectContaining({ rescan: true, signature_version: 2 }),
      }),
    ]);
    expect(t.events).toEqual(['file.rejected.v1']);
    expect(t.rechecks).toEqual([{ id: 'eicar-1-v1', signature: 2 }]);
  });

  it('keeps a clean file ready and only moves its checked-signature number forward; a second pass finds nothing', async () => {
    const clean = stored('clean-1', Buffer.from('a harmless brief'), 1);
    const t = harness([clean]);

    expect(await t.rescanner.rescan()).toMatchObject({ checked: 1, stillClean: 1, blocked: 0 });
    expect(clean.asset.status).toBe('ready');
    expect(t.withdrawn).toEqual([]);
    expect(t.notified).toEqual([]);
    expect(t.rechecks).toEqual([{ id: 'clean-1-v1', signature: 2 }]);

    expect(await t.rescanner.rescan()).toMatchObject({ organizations: 0, checked: 0 });
  });

  it('never runs without a real engine version: the none driver re-checks nothing', async () => {
    const t = harness(
      [stored('eicar-1', EICAR, null)],
      new NoneScanner() as unknown as StubScanner,
    );
    expect(await t.rescanner.rescan()).toMatchObject({ signatureVersion: null, checked: 0 });
    expect(t.files[0]?.asset.status).toBe('ready');
  });

  it('stops at its file budget and leaves the rest for the next pass', async () => {
    const files = [1, 2, 3].map((n) => stored(`f-${n}`, Buffer.from(`file ${n}`), null));
    const t = harness(files, new StubScanner(2), { files: 2, bytes: 1024 });
    expect(await t.rescanner.rescan()).toMatchObject({ checked: 2, budgetReached: true });
    expect(await t.rescanner.rescan()).toMatchObject({ checked: 1 });
  });

  it('refuses bytes that changed under a sealed version: an error, never a verdict', async () => {
    const tampered = stored('t-1', Buffer.from('original'), null);
    tampered.bytes = Buffer.from('changed!');
    const t = harness([tampered]);
    const report = await t.rescanner.rescan();
    expect(report).toMatchObject({ failed: 1, blocked: 0, stillClean: 0 });
    expect(tampered.asset.status).toBe('ready');
    expect(t.rechecks).toEqual([]);
  });
});

describe('FileScanner records the signature set with every verdict (QA-FIX S1)', () => {
  it('passes the engine version to recordScan', async () => {
    const facts: unknown[] = [];
    const bytes = Buffer.from('a harmless brief');
    const scanner = new FileScanner(
      {
        bootstrapRead: async () => [ORG],
        read: async (_ctx: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
        transaction: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
      } as unknown as TenantDatabase,
      {
        listAwaitingScan: (() => {
          let served = false;
          return async () => {
            if (served) return [];
            served = true;
            return [
              {
                id: 'a-1',
                projectId: 'p',
                purpose: 'attachment',
                objectId: null,
                scanClaimedAt: null,
              },
            ];
          };
        })(),
        claimForScan: async () => true,
        findLatestVersion: async () => ({
          id: 'v-1',
          objectKey: 'k',
          sizeBytes: bytes.length,
          contentHash: sha(bytes),
        }),
        recordScan: async (_tx: unknown, _ctx: unknown, _id: string, f: unknown) => {
          facts.push(f);
          return true;
        },
        transition: async () => ({}),
        findById: async () => ({ status: 'ready' }),
      } as unknown as FileAssetsRepository,
      {
        openObject: async () => ({ sizeBytes: bytes.length, stream: Readable.from([bytes]) }),
        promote: async () => ({
          sink: new (await import('node:stream')).Writable({ write: (_c, _e, cb) => cb() }),
          abort: async () => undefined,
          commit: async () => ({}),
        }),
        withdraw: async () => undefined,
      } as unknown as ObjectStore,
      new StubScanner(28189),
      null,
      null,
    );
    const report = await scanner.scan();
    expect(report.ready).toBe(1);
    expect(facts).toEqual([
      expect.objectContaining({
        scanVerdict: 'clean',
        engine: { text: 'stub/28189', signatureVersion: 28189 },
      }),
    ]);
  });
});

describe('FileScanJob runs the re-check after the scan pass, rate-limited (QA-FIX S1)', () => {
  it('re-checks on the first pass and then at most once per interval', async () => {
    let now = 0;
    let rescans = 0;
    const job = new FileScanJob(
      { verify: async () => ({}) as never },
      { scan: async () => ({ ready: 0, unscanned: 0 }) as never },
      true,
      { debounceMs: 0, bootDelayMs: 0, intervalMs: 60_000, log: () => undefined },
      null,
      {
        rescan: async () => {
          rescans += 1;
          return { signatureVersion: 1 } as never;
        },
      },
      10 * 60_000,
      () => now,
    );
    await job.runNow();
    now = 5 * 60_000;
    await job.runNow();
    now = 11 * 60_000;
    await job.runNow();
    expect(rescans).toBe(2);
  });
});
