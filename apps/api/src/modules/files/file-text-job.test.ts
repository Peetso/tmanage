import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { DEFAULT_TEXT_LIMITS } from './file-text-extractors.js';
import { DEFAULT_FILE_TEXT_JOB_OPTIONS, FileTextJob, fileTextJobEnabled } from './file-text-job.js';
import type { FileTextJobOptions } from './file-text-job.js';
import { FILE_TEXT_MAX_ATTEMPTS } from './file-texts.repository.js';
import type {
  ConcludedText,
  FileText,
  FileTextsRepository,
  HashNeedingText,
} from './file-texts.repository.js';

/**
 * 62-23 §9 row: "only scan-clean files; cap and timeout; same hash extracted once". The SQL half
 * (servable versions only, one row per workspace and hash) is `t-62-23-file-texts.db.test.ts`.
 */

const ORG = '0190a3e4-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-11-21T09:00:00.000Z');

interface Version {
  id: string;
  fileAssetId: string;
  contentHash: string;
  detectedMimeType: string;
  sizeBytes: number;
  scanVerdict: string;
  trustZone: string;
  objectKey: string;
  organizationId: string;
  storageBackend: string;
  providerFileId: null;
  storageConnectionId: null;
  body: string;
}

function version(id: string, overrides: Partial<Version> = {}): Version {
  const body = overrides.body ?? `text of ${id}`;
  return {
    id,
    fileAssetId: `asset-${id}`,
    contentHash: `hash-${id}`,
    detectedMimeType: 'text/plain',
    sizeBytes: Buffer.byteLength(body),
    scanVerdict: 'clean',
    trustZone: 'private',
    objectKey: `key-${id}`,
    organizationId: ORG,
    storageBackend: 'local',
    providerFileId: null,
    storageConnectionId: null,
    ...overrides,
    body,
  };
}

type Row = {
  -readonly [K in keyof FileText]: FileText[K];
} & {
  status: FileText['status'];
  reasonCode?: string | null;
  body?: string | null;
  extractor?: string | null;
};

/** The repository's contract in memory: one row per hash, conditional claims and moves. */
class FakeTexts {
  rows = new Map<string, Row>();
  constructor(readonly versions: Version[]) {}

  organizationsWithWork() {
    return Promise.resolve([ORG]);
  }
  listHashesNeedingText(): Promise<HashNeedingText[]> {
    const seen = new Set<string>();
    return Promise.resolve(
      this.versions.flatMap((v) => {
        if (this.rows.has(v.contentHash) || seen.has(v.contentHash)) return [];
        seen.add(v.contentHash);
        return [{ contentHash: v.contentHash, mimeType: v.detectedMimeType }];
      }),
    );
  }
  ensurePending(_tx: unknown, _c: unknown, hash: HashNeedingText) {
    if (!this.rows.has(hash.contentHash)) {
      this.rows.set(hash.contentHash, {
        id: `text-${hash.contentHash}`,
        organizationId: ORG,
        contentHash: hash.contentHash,
        mimeType: hash.mimeType,
        status: 'pending',
        attempts: 0,
        claimedAt: null,
      });
    }
    return Promise.resolve();
  }
  listClaimable() {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.status === 'pending').map((r) => ({ ...r })),
    );
  }
  claim(_tx: unknown, _c: unknown, row: FileText) {
    const live = [...this.rows.values()].find((r) => r.id === row.id);
    return Promise.resolve(live?.status === 'pending' && live.attempts === row.attempts);
  }
  findVersionForHash(_db: unknown, _c: unknown, hash: string) {
    const v = this.versions.find((x) => x.contentHash === hash);
    return Promise.resolve(v ? { fileAssetId: v.fileAssetId, fileVersionId: v.id } : null);
  }
  conclude(_tx: unknown, _c: unknown, id: string, outcome: ConcludedText) {
    const live = [...this.rows.values()].find((r) => r.id === id);
    if (live?.status !== 'pending') return Promise.resolve(false);
    Object.assign(live, outcome);
    return Promise.resolve(true);
  }
  recordAttempt(_tx: unknown, _c: unknown, row: FileText, code: string) {
    const live = [...this.rows.values()].find((r) => r.id === row.id)!;
    live.attempts += 1;
    live.reasonCode = code;
    if (live.attempts >= FILE_TEXT_MAX_ATTEMPTS) {
      live.status = 'failed';
      return Promise.resolve('failed' as const);
    }
    return Promise.resolve('retrying' as const);
  }
  deleteOrphans() {
    return Promise.resolve(0);
  }
}

const database = {
  bootstrapRead: (_o: unknown, work: (db: unknown) => unknown) => work({}),
  read: (_c: unknown, work: (db: unknown) => unknown) => work({}),
  transaction: (_c: unknown, work: (tx: unknown) => unknown) => work({}),
} as unknown as TenantDatabase;

function setup(
  versions: Version[],
  options: Partial<FileTextJobOptions> = {},
  assetStatus = 'ready',
  storeFails = false,
) {
  const texts = new FakeTexts(versions);
  const opened: string[] = [];
  const assets = {
    findById: (_db: unknown, _c: unknown, id: string) =>
      Promise.resolve({ id, status: assetStatus, deletedAt: null }),
    findVersionById: (_db: unknown, _c: unknown, id: string) =>
      Promise.resolve(versions.find((v) => v.id === id) ?? null),
  };
  const store = {
    openObject: ({ objectKey }: { objectKey: string }) => {
      opened.push(objectKey);
      if (storeFails) return Promise.reject(new Error('disk'));
      const v = versions.find((x) => x.objectKey === objectKey)!;
      return Promise.resolve({
        sizeBytes: v.sizeBytes,
        stream: Readable.from([Buffer.from(v.body)]),
      });
    },
  };
  const job = new FileTextJob(
    database,
    texts as unknown as FileTextsRepository,
    assets as never,
    store as never,
    true,
    { ...DEFAULT_FILE_TEXT_JOB_OPTIONS, log: () => undefined, ...options },
    () => NOW,
  );
  return { job, texts, opened };
}

describe('text job (62-23)', () => {
  it('extracts a clean file once per content hash, even when two versions share it', async () => {
    const shared = { contentHash: 'hash-same', body: 'Q3 brief' };
    const { job, texts, opened } = setup([version('a', shared), version('b', shared)]);
    const report = await job.pass();
    expect(report).toMatchObject({ planned: 1, ready: 1, failed: 0 });
    expect(opened).toEqual(['key-a']);
    expect(texts.rows.get('hash-same')).toMatchObject({
      status: 'ready',
      body: 'Q3 brief',
      extractor: 'plain',
    });
    // A second pass finds nothing to do.
    expect(await job.pass()).toMatchObject({ planned: 0, ready: 0 });
    expect(opened).toEqual(['key-a']);
  });

  it('never reads a file that is not scan-clean and promoted (AR-8 re-check)', async () => {
    for (const overrides of [
      { scanVerdict: 'unscanned' },
      { scanVerdict: 'infected' },
      { trustZone: 'quarantine' },
    ]) {
      const { job, texts, opened } = setup([version('x', overrides)]);
      await job.pass();
      expect(opened, JSON.stringify(overrides)).toEqual([]);
      expect(texts.rows.get('hash-x')).toMatchObject({
        status: 'unsupported',
        reasonCode: 'not_servable',
        body: null,
      });
    }
    const scanning = setup([version('y')], {}, 'scanning');
    await scanning.job.pass();
    expect(scanning.opened).toEqual([]);
  });

  it('refuses an oversized file unread, and a slow one ends as a timeout', async () => {
    const big = setup([version('big')], {
      limits: { ...DEFAULT_TEXT_LIMITS, maxInputBytes: 4 },
    });
    await big.job.pass();
    expect(big.opened).toEqual([]);
    expect(big.texts.rows.get('hash-big')).toMatchObject({
      status: 'unsupported',
      reasonCode: 'unsupported_too_large',
    });
    const slow = setup([version('slow')], { limits: { ...DEFAULT_TEXT_LIMITS, timeoutMs: -1 } });
    await slow.job.pass();
    expect(slow.texts.rows.get('hash-slow')).toMatchObject({
      status: 'failed',
      reasonCode: 'timeout',
    });
  });

  it('a store fault is retried, then failed after the last attempt', async () => {
    const { job, texts } = setup([version('s')], {}, 'ready', true);
    expect(await job.pass()).toMatchObject({ retrying: 1 });
    expect(texts.rows.get('hash-s')).toMatchObject({ status: 'pending', attempts: 1 });
    await job.pass();
    expect(await job.pass()).toMatchObject({ failed: 1 });
    expect(texts.rows.get('hash-s')).toMatchObject({
      status: 'failed',
      reasonCode: 'object_unreadable',
    });
  });

  it('runs in-process only when background work runs here', () => {
    expect(fileTextJobEnabled({})).toBe(false);
    expect(fileTextJobEnabled({ WORKER_INPROCESS: '1' })).toBe(true);
    expect(fileTextJobEnabled({ FILE_TEXT_INPROCESS: '1' })).toBe(true);
  });
});
