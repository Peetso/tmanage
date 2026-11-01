import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import { ObjectStoreUnavailableError } from '../../common/storage/storage.module.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type {
  EnsurePendingInput,
  FilePreview,
  FilePreviewsRepository,
  ReadyPreviewInput,
} from './file-previews.repository.js';
import { FileScanJob } from './file-scan-job.js';
import { pngCodec } from './preview-generators/codecs.js';
import { imageGenerator } from './preview-generators/image.js';
import { mediaMetaGenerator } from './preview-generators/media-meta.js';
import { tiffGenerator } from './preview-generators/tiff.js';
import { utifCodec } from './preview-generators/codecs.js';
import type { PreviewGenerator } from './preview-generators/types.js';
import {
  DEFAULT_PREVIEW_JOB_OPTIONS,
  PreviewJob,
  describePreviewPass,
  previewJobEnabled,
  previewJobOptionsFromEnv,
} from './preview-job.js';
import type { PreviewJobOptions } from './preview-job.js';
import type { PreviewUsageMeter } from './preview-usage.js';

/**
 * R4 slice 3 — the preview job against in-memory fakes of its two repositories and the store,
 * with the real image and TIFF generators: plan, claim, draw, record, and every way a row can end.
 */

const ORG = uuidv7();
const NOW = new Date('2026-11-01T10:00:00.000Z');

function pngBytes(width: number, height: number): Uint8Array {
  const { PNG } = pngCodec();
  const png = new PNG({ width, height });
  png.data.fill(180);
  return new Uint8Array(PNG.sync.write(png));
}

function twoPageTiff(): Uint8Array {
  const page = (w: number, h: number, offset: number) => ({
    t256: [w],
    t257: [h],
    t258: [8, 8, 8, 8],
    t259: [1],
    t262: [2],
    t273: [offset],
    t277: [4],
    t278: [h],
    t279: [w * h * 4],
    t284: [1],
    t338: [1],
  });
  const prefix = new Uint8Array(utifCodec().encode([page(4, 4, 1000), page(4, 4, 1064)]));
  const out = new Uint8Array(1128).fill(120);
  out.set(prefix);
  return out;
}

interface FileFixture {
  asset: FileAssetRow;
  version: FileVersionRow;
  bytes: Uint8Array;
}

function file(
  mimeType: string,
  bytes: Uint8Array,
  overrides: Partial<FileVersionRow> = {},
): FileFixture {
  const assetId = uuidv7();
  const versionId = uuidv7();
  return {
    asset: {
      id: assetId,
      organizationId: ORG,
      status: 'ready',
      deletedAt: null,
    } as FileAssetRow,
    version: {
      id: versionId,
      organizationId: ORG,
      fileAssetId: assetId,
      versionNo: 1,
      objectKey: `tenant/${ORG}/upload/${versionId}`,
      sizeBytes: bytes.byteLength,
      declaredMimeType: mimeType,
      detectedMimeType: mimeType,
      scanVerdict: 'clean',
      trustZone: 'private',
      createdAt: NOW,
      ...overrides,
    } as FileVersionRow,
    bytes,
  };
}

/** The repository's contract, in memory: the conditions the SQL carries, applied to rows. */
class MemoryPreviews {
  rows: FilePreview[] = [];
  claimsLost = new Set<string>();

  constructor(private readonly files: () => readonly FileFixture[]) {}

  private needing(mimeTypes: readonly string[]): FileFixture[] {
    return this.files().filter(
      (f) =>
        ((f.version.trustZone === 'private' &&
          f.version.scanVerdict === 'clean' &&
          f.asset.status === 'ready') ||
          (f.version.scanVerdict === 'unscanned' &&
            (f.asset.status === 'ready' || f.asset.status === 'scanning'))) &&
        mimeTypes.includes(f.version.detectedMimeType ?? '') &&
        !this.rows.some((row) => row.fileVersionId === f.version.id),
    );
  }

  async organizationsNeedingPreviews(_db: unknown, mimeTypes: readonly string[]) {
    return this.needing(mimeTypes).length > 0 ? [ORG] : [];
  }

  async listVersionsNeedingPreviews(_db: unknown, _c: unknown, mimeTypes: readonly string[]) {
    return this.needing(mimeTypes).map((f) => ({
      fileAssetId: f.asset.id,
      fileVersionId: f.version.id,
      mimeType: f.version.detectedMimeType!,
    }));
  }

  async ensurePending(_db: unknown, _c: unknown, input: EnsurePendingInput) {
    for (const spec of input.previews) {
      const pageNo = spec.pageNo ?? 0;
      const exists = this.rows.some(
        (row) =>
          row.fileVersionId === input.fileVersionId &&
          row.kind === spec.kind &&
          row.pageNo === pageNo,
      );
      if (exists) continue;
      this.rows.push({
        id: uuidv7(),
        organizationId: ORG,
        fileAssetId: input.fileAssetId,
        fileVersionId: input.fileVersionId,
        kind: spec.kind,
        pageNo,
        status: 'pending',
        objectKey: null,
        mimeType: null,
        sizeBytes: null,
        width: null,
        height: null,
        meta: null,
        errorCode: null,
        attempts: 0,
        claimedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
  }

  private open(staleBefore: Date) {
    return this.rows.filter(
      (row) => row.status === 'pending' && (row.claimedAt === null || row.claimedAt < staleBefore),
    );
  }

  async organizationsWithPending(_db: unknown, staleBefore: Date) {
    return this.open(staleBefore).length > 0 ? [ORG] : [];
  }

  async listPending(_db: unknown, _c: unknown, staleBefore: Date, limit: number) {
    return this.open(staleBefore)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  private find(id: string): FilePreview {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  private replace(id: string, patch: Partial<FilePreview>): void {
    this.rows = this.rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
  }

  async claim(_db: unknown, _c: unknown, row: Pick<FilePreview, 'id' | 'attempts'>, now: Date) {
    if (this.claimsLost.has(row.id)) return false;
    const current = this.find(row.id);
    if (current.status !== 'pending' || current.attempts !== row.attempts) return false;
    this.replace(row.id, { claimedAt: now });
    return true;
  }

  async markReady(_db: unknown, _c: unknown, id: string, input: ReadyPreviewInput) {
    if (this.find(id).status !== 'pending') return false;
    this.replace(id, { status: 'ready', ...input, claimedAt: null });
    return true;
  }

  async markUnsupported(_db: unknown, _c: unknown, id: string, errorCode: string) {
    if (this.find(id).status !== 'pending') return false;
    this.replace(id, { status: 'unsupported', errorCode, claimedAt: null });
    return true;
  }

  async recordFailure(
    _db: unknown,
    _c: unknown,
    row: Pick<FilePreview, 'id' | 'attempts'>,
    errorCode: string,
    _now: Date,
    maxAttempts: number,
  ) {
    const current = this.find(row.id);
    if (current.status !== 'pending' || current.attempts !== row.attempts)
      return 'not_pending' as const;
    const attempts = row.attempts + 1;
    const final = attempts >= maxAttempts;
    this.replace(row.id, {
      attempts,
      errorCode,
      ...(final ? { status: 'failed' as const, claimedAt: null } : {}),
    });
    return final ? ('failed' as const) : ('retry' as const);
  }
}

function harness(
  files: FileFixture[],
  options: Partial<PreviewJobOptions> = {},
  generators: readonly PreviewGenerator[] = [imageGenerator, tiffGenerator],
  storeOverrides: Partial<ObjectStore> = {},
  rss = () => 100,
  usage: PreviewUsageMeter | null = null,
) {
  const clock = { now: NOW };
  const previews = new MemoryPreviews(() => files);
  const derived = new Map<string, Uint8Array>();
  const runner = {};
  const database = {
    bootstrapRead: (_o: unknown, work: (db: unknown) => Promise<unknown>) => work(runner),
    read: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work(runner),
    transaction: (_c: unknown, work: (db: unknown) => Promise<unknown>) => work(runner),
  } as unknown as TenantDatabase;
  const assets = {
    findById: async (_db: unknown, _c: unknown, id: string) =>
      files.find((f) => f.asset.id === id)?.asset ?? null,
    findVersionById: async (_db: unknown, _c: unknown, id: string) =>
      files.find((f) => f.version.id === id)?.version ?? null,
  } as unknown as FileAssetsRepository;
  const opened: string[] = [];
  const store = {
    openObject: async ({ zone, objectKey }: { zone: string; objectKey: string }) => {
      opened.push(objectKey);
      const found = files.find((f) => f.version.objectKey === objectKey);
      if (!found) throw new ObjectNotFoundError();
      // Read from the zone the version sits in: quarantine for one never scanned.
      expect(zone).toBe(found.version.trustZone === 'private' ? 'private' : 'quarantine');
      return {
        sizeBytes: found.bytes.byteLength,
        stream: Readable.from([Buffer.from(found.bytes)]),
      };
    },
    putDerivative: async ({ objectKey, body }: { objectKey: string; body: Uint8Array }) => {
      derived.set(objectKey, body);
      return { objectKey, sizeBytes: body.byteLength };
    },
    ...storeOverrides,
  } as unknown as ObjectStore;
  const log = vi.fn();
  const job = new PreviewJob(
    database,
    previews as unknown as FilePreviewsRepository,
    assets,
    store,
    true,
    { ...DEFAULT_PREVIEW_JOB_OPTIONS, bootDelayMs: 0, debounceMs: 0, log, ...options },
    generators,
    () => clock.now,
    rss,
    usage,
  );
  return { job, previews, derived, opened, log, clock };
}

describe('PreviewJob — plan and draw', () => {
  it('plans a ready PNG, reads its object once, and stores a preview and a thumb', async () => {
    const png = file('image/png', pngBytes(600, 300));
    const t = harness([png]);
    const report = await t.job.pass();
    expect(report).toMatchObject({
      organizations: 1,
      planned: 1,
      ready: 2,
      failed: 0,
      stoppedBy: null,
    });
    expect(t.opened).toEqual([png.version.objectKey]);
    const byKind = Object.fromEntries(t.previews.rows.map((row) => [row.kind, row]));
    expect(byKind['preview']).toMatchObject({
      status: 'ready',
      mimeType: 'image/webp',
      width: 600,
      height: 300,
    });
    expect(byKind['thumb']).toMatchObject({ status: 'ready', width: 320, height: 160 });
    for (const row of t.previews.rows) {
      expect(row.objectKey).toBe(`tenant/${ORG}/derivative/${png.version.id}/${row.id}`);
      expect(t.derived.get(row.objectKey!)?.byteLength).toBe(row.sizeBytes);
    }
    // A second pass finds nothing to plan and nothing pending.
    expect(await t.job.pass()).toMatchObject({ organizations: 0, planned: 0, ready: 0 });
  });

  it('counts each stored derivative against the quota in its ready transaction', async () => {
    const count = vi.fn(async () => true);
    const t = harness([file('image/png', pngBytes(40, 20))], {}, undefined, {}, undefined, {
      count,
    } as unknown as PreviewUsageMeter);
    await t.job.pass();
    expect(count).toHaveBeenCalledTimes(2);
    const sizes = count.mock.calls.map((call) => (call as unknown[])[2] as { sizeBytes: number });
    expect(sizes.map((p) => p.sizeBytes).sort()).toEqual(
      t.previews.rows.map((row) => row.sizeBytes).sort(),
    );
  });

  it('skips files that are not promoted and clean, and types no generator reads', async () => {
    const unscanned = file('image/png', pngBytes(2, 2), { scanVerdict: null });
    const pdf = file('application/pdf', new Uint8Array(10));
    const t = harness([unscanned, pdf]);
    expect(await t.job.pass()).toMatchObject({ planned: 0, ready: 0 });
    expect(t.previews.rows).toEqual([]);
  });

  it('previews an unscanned file (the none driver) from quarantine, as the download door serves it', async () => {
    const png = file('image/png', pngBytes(600, 300), {
      scanVerdict: 'unscanned',
      trustZone: 'quarantine',
    });
    png.asset = { ...png.asset, status: 'scanning' };
    const t = harness([png]);
    const report = await t.job.pass();
    expect(report.ready).toBeGreaterThan(0);
    expect(t.opened).toEqual([png.version.objectKey]);
    expect(t.previews.rows.every((row) => row.status === 'ready')).toBe(true);
  });

  it('inserts a multi-page TIFF follow-up rows and draws them in the same pass', async () => {
    const tif = file('image/tiff', twoPageTiff());
    const t = harness([tif]);
    const report = await t.job.pass();
    const shape = t.previews.rows.map((row) => `${row.kind}:${row.pageNo}:${row.status}`).sort();
    expect(shape).toEqual([
      'page_thumb:1:ready',
      'page_thumb:2:ready',
      'preview:1:ready',
      'preview:2:ready',
      'thumb:0:ready',
    ]);
    expect(report.ready).toBe(5);
  });

  it('a video gets one facts-only media_meta row: ready, no bytes stored, no key (R4 slice 9)', async () => {
    const facts: PreviewGenerator = {
      ...mediaMetaGenerator,
      generate: async (_source, requests) =>
        requests.map(() => ({
          status: 'ready' as const,
          body: null,
          mimeType: null,
          width: 1920,
          height: 1080,
          meta: { durationMs: 90_000, codecNotice: null },
        })),
    };
    const mp4 = file('video/mp4', new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
    const t = harness([mp4], {}, [facts]);
    expect(await t.job.pass()).toMatchObject({ planned: 1, ready: 1, failed: 0 });
    expect(t.previews.rows).toHaveLength(1);
    expect(t.previews.rows[0]).toMatchObject({
      kind: 'media_meta',
      status: 'ready',
      objectKey: null,
      mimeType: null,
      sizeBytes: 0,
      width: 1920,
      meta: { durationMs: 90_000, codecNotice: null },
    });
    expect(t.derived.size).toBe(0);
  });
});

describe('PreviewJob — how a row ends', () => {
  it('a version larger than the input cap is unsupported without being read', async () => {
    const png = file('image/png', pngBytes(4, 4));
    const t = harness([png], { maxInputBytes: 10 });
    expect(await t.job.pass()).toMatchObject({ unsupported: 2, ready: 0 });
    expect(t.opened).toEqual([]);
    expect(t.previews.rows.every((row) => row.errorCode === 'unsupported_too_large')).toBe(true);
  });

  it('bytes that will not decode fail at once (no retries spent on the same bytes)', async () => {
    const broken = file('image/png', pngBytes(4, 4).subarray(0, 40));
    const t = harness([broken]);
    expect(await t.job.pass()).toMatchObject({ failed: 2, retrying: 0 });
    expect(t.previews.rows.map((row) => [row.status, row.errorCode, row.attempts])).toEqual([
      ['failed', 'decode_failed', 1],
      ['failed', 'decode_failed', 1],
    ]);
  });

  it('a missing object counts an attempt and keeps the claim; the third attempt fails the row', async () => {
    const png = file('image/png', pngBytes(4, 4));
    const t = harness([png], {}, undefined, {
      openObject: () => Promise.reject(new ObjectNotFoundError()),
    });
    expect(await t.job.pass()).toMatchObject({ retrying: 2, failed: 0 });
    const first = t.previews.rows[0]!;
    expect(first).toMatchObject({ status: 'pending', attempts: 1, errorCode: 'object_not_found' });
    expect(first.claimedAt).toEqual(NOW);
    // Inside the stale bound the claimed rows wait; past it they are tried again.
    expect(await t.job.pass()).toMatchObject({ organizations: 0, retrying: 0 });
    t.clock.now = new Date(NOW.getTime() + 16 * 60_000);
    expect(await t.job.pass()).toMatchObject({ retrying: 2 });
    t.clock.now = new Date(NOW.getTime() + 32 * 60_000);
    expect(await t.job.pass()).toMatchObject({ failed: 2 });
    expect(t.previews.rows.every((row) => row.status === 'failed' && row.attempts === 3)).toBe(
      true,
    );
  });

  it('a generator that throws is the job’s fault, not the file’s: an attempt, logged', async () => {
    const throwing: PreviewGenerator = {
      ...imageGenerator,
      name: 'throwing',
      generate: () => Promise.reject(new Error('wasm trapped')),
    };
    const t = harness([file('image/png', pngBytes(2, 2))], {}, [throwing]);
    expect(await t.job.pass()).toMatchObject({ retrying: 2 });
    expect(t.previews.rows[0]?.errorCode).toBe('generator_error');
    expect(t.log).toHaveBeenCalledWith(expect.stringMatching(/\(throwing\) failed/));
  });

  it('a row another pass claimed first is skipped, untouched', async () => {
    const png = file('image/png', pngBytes(2, 2));
    const t = harness([png]);
    await t.previews.ensurePending(null, null, {
      fileAssetId: png.asset.id,
      fileVersionId: png.version.id,
      previews: [{ kind: 'preview' }, { kind: 'thumb' }],
    });
    t.previews.claimsLost.add(t.previews.rows[0]!.id);
    const report = await t.job.pass();
    expect(report).toMatchObject({ skipped: 1, ready: 1 });
    expect(t.previews.rows[0]?.status).toBe('pending');
  });

  it('a deleted asset or a version no longer servable makes nothing', async () => {
    const png = file('image/png', pngBytes(2, 2));
    const t = harness([png]);
    await t.previews.ensurePending(null, null, {
      fileAssetId: png.asset.id,
      fileVersionId: png.version.id,
      previews: [{ kind: 'thumb' }],
    });
    png.asset = { ...png.asset, deletedAt: NOW };
    expect(await t.job.pass()).toMatchObject({ unsupported: 1 });
    expect(t.previews.rows[0]?.errorCode).toBe('not_servable');
    expect(t.opened).toEqual([]);
  });
});

describe('PreviewJob — bounds', () => {
  it('stops before a decode when the resident set is above the ceiling; rows wait unclaimed', async () => {
    const t = harness(
      [file('image/png', pngBytes(2, 2))],
      { rssCeilingBytes: 50 },
      undefined,
      {},
      () => 100,
    );
    const report = await t.job.pass();
    expect(report).toMatchObject({ planned: 1, ready: 0, stoppedBy: 'memory' });
    expect(t.previews.rows.every((row) => row.status === 'pending' && row.claimedAt === null)).toBe(
      true,
    );
    expect(describePreviewPass(report)).toMatch(/stopped by memory/);
  });

  it('an unreachable store stops the pass, and runNow logs it instead of throwing', async () => {
    const t = harness([file('image/png', pngBytes(2, 2))], {}, undefined, {
      openObject: () => Promise.reject(new ObjectStoreUnavailableError()),
    });
    await expect(t.job.runNow()).resolves.toBeUndefined();
    expect(t.log).toHaveBeenCalledWith(expect.stringMatching(/^\[preview\] pass failed/));
  });
});

describe('PreviewJob — switches and scheduling', () => {
  it('runs in-process only under WORKER_INPROCESS=1 or FILE_PREVIEW_INPROCESS=1', () => {
    expect(previewJobEnabled({})).toBe(false);
    expect(previewJobEnabled({ WORKER_INPROCESS: '1' })).toBe(true);
    expect(previewJobEnabled({ FILE_PREVIEW_INPROCESS: '1' })).toBe(true);
  });

  it('reads the caps from the environment, ignoring values that are not positive integers', () => {
    const options = previewJobOptionsFromEnv({
      PREVIEW_MAX_PIXELS: '1000',
      PREVIEW_MAX_INPUT_BYTES: 'lots',
      PREVIEW_RSS_CEILING_BYTES: '-5',
    });
    expect(options.limits.maxPixels).toBe(1000);
    expect(options.maxInputBytes).toBe(DEFAULT_PREVIEW_JOB_OPTIONS.maxInputBytes);
    expect(options.rssCeilingBytes).toBe(DEFAULT_PREVIEW_JOB_OPTIONS.rssCeilingBytes);
  });

  it('a disabled job ignores requests and boot', async () => {
    const t = harness([file('image/png', pngBytes(2, 2))]);
    const off = new PreviewJob(
      {} as TenantDatabase,
      t.previews as unknown as FilePreviewsRepository,
      {} as FileAssetsRepository,
      {} as ObjectStore,
      false,
    );
    off.request();
    off.onApplicationBootstrap();
    await new Promise((done) => setTimeout(done, 5));
    expect(t.previews.rows).toEqual([]);
    await off.onModuleDestroy();
  });

  it('a scan pass that made files ready asks the preview job for a pass', async () => {
    const request = vi.fn();
    const report = {
      organizations: 1,
      scanned: 1,
      verified: 1,
      rejected: 0,
      skipped: 0,
      failed: 0,
      reran: 0,
    };
    const scan = vi.fn(async () => ({ ...report, ready: 1, unscanned: 0 }));
    const scanJob = new FileScanJob(
      { verify: async () => report },
      { scan },
      true,
      { debounceMs: 0, bootDelayMs: 0, intervalMs: 60_000, log: () => {} },
      { request },
    );
    await scanJob.runNow();
    expect(request).toHaveBeenCalledTimes(1);
    scan.mockResolvedValueOnce({ ...report, ready: 0, unscanned: 0 });
    await scanJob.runNow();
    expect(request).toHaveBeenCalledTimes(1);
    await scanJob.onModuleDestroy();
  });
});
