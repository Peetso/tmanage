import { Readable, Writable } from 'node:stream';
import type { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ObjectStore, Promotion } from '@tmanage/storage';
import { ScanError } from '../../common/scan/malware-scanner.js';
import type { MalwareScanner, ScanInput, ScanResult } from '../../common/scan/malware-scanner.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { FileScanner } from './file-scanner.js';

/**
 * W01 (Codex review, 2026-09-05) — the scan pass's failure paths, without a database.
 *
 * The pass tees one quarantine read into the digest, the promotion's sink and the
 * scanner's stream. When the read or the sink broke, the pass asked the scanner what it
 * had seen **before** it stopped feeding the scanner — and a driver that drains its
 * stream to the end (every driver, by contract) waited for an end that never came. The
 * same tee stalls the other way round: an engine that fails early stops reading, and the
 * pass's next write into the full `PassThrough` never calls back.
 *
 * Each failure here is raced against a clock. Before the fix the race is what settles;
 * after it, the pass does — with the primary cause, the promotion aborted and every
 * stream closed. The happy path is kept in the same file so the reversal is one run.
 */

const SOURCE_FAILURE = 'synthetic source I/O failure';
const SINK_FAILURE = 'synthetic sink write failure';
/** Long enough for a stall to be a stall on a loaded machine; short enough to run on every save. */
const STALL_MS = 1_000;

const row = { id: 'asset-1', projectId: 'project-1', purpose: 'attachment', objectId: 'object-1' };
const version = (sizeBytes: number, contentHash: string) =>
  ({ id: 'version-1', objectKey: 'org/asset-1/v1', sizeBytes, contentHash }) as FileVersionRow;

interface Harness {
  readonly promotion: { aborted: number; committed: number; sink: Writable };
  readonly scannerInput: () => PassThrough | undefined;
  readonly source: Readable;
  readonly withdrawn: string[];
  readonly transitions: string[];
  judge(): Promise<'ready' | 'rejected' | 'skipped'>;
}

function harness(options: {
  source: Readable;
  sink?: Writable;
  scanner?: MalwareScanner;
  sizeBytes: number;
  contentHash: string;
}): Harness {
  const promotion = {
    aborted: 0,
    committed: 0,
    sink: options.sink ?? new Writable({ write: (_chunk, _encoding, callback) => callback() }),
  };
  const withdrawn: string[] = [];
  const store = {
    openObject: async () => ({ sizeBytes: options.sizeBytes, stream: options.source }),
    promote: async (): Promise<Promotion> => ({
      sink: promotion.sink,
      abort: async () => {
        promotion.aborted += 1;
      },
      commit: async () => {
        promotion.committed += 1;
        return { objectKey: 'org/asset-1/v1', sizeBytes: options.sizeBytes, etag: 'synthetic' };
      },
    }),
    withdraw: async ({ objectKey }: { objectKey: string }) => {
      withdrawn.push(objectKey);
    },
  } as unknown as ObjectStore;

  let input: PassThrough | undefined;
  const scanner: MalwareScanner = options.scanner ?? {
    name: 'stub',
    kind: 'engine',
    probe: async () => undefined,
    scan: async ({ stream }: ScanInput): Promise<ScanResult> => {
      input = stream as PassThrough;
      for await (const _chunk of stream) {
        // Drained to the end, as every driver is required to.
      }
      return { verdict: 'clean' };
    },
  };
  const wrapped: MalwareScanner = {
    ...scanner,
    scan: (scanInput) => {
      input = scanInput.stream as PassThrough;
      return scanner.scan(scanInput);
    },
  };

  const transitions: string[] = [];
  const assets = {
    recordScan: async () => true,
    transition: async (_tx: unknown, _context: unknown, _id: string, status: string) => {
      transitions.push(status);
    },
    findById: async () => ({ ...row, status: transitions.at(-1) ?? 'scanning' }),
    findVersionById: async () => null,
  } as unknown as FileAssetsRepository;
  const database = {
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const instance = new FileScanner(database, assets, store, wrapped, null, null);
  const judge = (
    instance as unknown as {
      judge(
        context: unknown,
        row: unknown,
        version: FileVersionRow,
      ): Promise<'ready' | 'rejected' | 'skipped'>;
    }
  ).judge.bind(instance);

  return {
    promotion,
    scannerInput: () => input,
    source: options.source,
    withdrawn,
    transitions,
    judge: () =>
      judge(
        { correlationId: 'corr-1' },
        row as unknown as FileAssetRow,
        version(options.sizeBytes, options.contentHash),
      ),
  };
}

/** Settles with the outcome, or with `'still pending'` when the pass has not settled in time. */
async function settleOrStall<T>(
  pending: Promise<T>,
): Promise<T | 'still pending' | { rejected: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const clock = new Promise<'still pending'>((resolve) => {
    timer = setTimeout(() => resolve('still pending'), STALL_MS);
  });
  try {
    return await Promise.race([
      pending.then(
        (value) => value,
        (error: unknown) => ({ rejected: error }),
      ),
      clock,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const failingSource = () =>
  Readable.from(
    (async function* () {
      yield Buffer.from('x');
      throw new Error(SOURCE_FAILURE);
    })(),
  );

/** Enough chunks to fill a `PassThrough` nobody reads (16 KiB default high-water mark). */
const longSource = () =>
  Readable.from(
    (async function* () {
      for (let i = 0; i < 64; i += 1) yield Buffer.alloc(1024, i);
    })(),
  );

describe('FileScanner.judge, when the read or the sink breaks under a scanner that drains to the end (W01)', () => {
  it('settles promptly on a source failure: the primary cause, the promotion aborted, the scanner released', async () => {
    const h = harness({ source: failingSource(), sizeBytes: 2, contentHash: 'irrelevant' });
    const outcome = await settleOrStall(h.judge());

    expect(outcome).not.toBe('still pending');
    expect(outcome).toMatchObject({ rejected: { name: 'ScanFailure', failure: 'stream_error' } });
    expect(h.promotion.aborted).toBe(1);
    expect(h.promotion.committed).toBe(0);
    expect(h.scannerInput()?.destroyed).toBe(true);
    expect(h.source.destroyed).toBe(true);
  });

  it('settles promptly on a sink failure, with the sink’s error as a stream error rather than the scanner’s verdict', async () => {
    const sink = new Writable({
      write: (_chunk, _encoding, callback) => callback(new Error(SINK_FAILURE)),
    });
    const h = harness({
      source: longSource(),
      sink,
      sizeBytes: 64 * 1024,
      contentHash: 'irrelevant',
    });
    const outcome = await settleOrStall(h.judge());

    expect(outcome).not.toBe('still pending');
    expect(outcome).toMatchObject({ rejected: { name: 'ScanFailure', failure: 'stream_error' } });
    expect(h.promotion.aborted).toBe(1);
    expect(h.scannerInput()?.destroyed).toBe(true);
  });

  it('settles promptly when the engine fails early and stops reading: the engine’s own failure is the cause', async () => {
    const early: MalwareScanner = {
      name: 'clamav',
      kind: 'engine',
      probe: async () => undefined,
      scan: async () => {
        // Answers before reading a byte and never drains — a daemon that rejected the size.
        throw new ScanError('engine_error');
      },
    };
    const h = harness({
      source: longSource(),
      scanner: early,
      sizeBytes: 64 * 1024,
      contentHash: 'irrelevant',
    });
    const outcome = await settleOrStall(h.judge());

    expect(outcome).not.toBe('still pending');
    expect(outcome).toMatchObject({ rejected: { name: 'ScanFailure', failure: 'engine_error' } });
    expect(h.promotion.aborted).toBe(1);
    expect(h.source.destroyed).toBe(true);
  });

  it('keeps a size mismatch as the cause when the engine only failed because the pass released it', async () => {
    // Three bytes arrive for a version of two: the pass throws size_mismatch mid-loop and
    // must not let the released scanner’s premature-close rewrite the cause.
    const oversize = Readable.from([Buffer.from('abc')]);
    const h = harness({ source: oversize, sizeBytes: 2, contentHash: 'irrelevant' });
    const outcome = await settleOrStall(h.judge());

    expect(outcome).not.toBe('still pending');
    expect(outcome).toMatchObject({ rejected: { name: 'ScanFailure', failure: 'size_mismatch' } });
    expect(h.promotion.aborted).toBe(1);
  });

  it('settles promptly when the engine fails after a write is already blocked on its tee (Codex review, 2026-09-06)', async () => {
    // Unlike the early-failure case above, this driver answers only once a write into
    // the unconsumed tee is already stuck behind the readable side's high-water mark —
    // the timing the plain `.destroy()` on that tee left unresolved.
    const delayedEarly: MalwareScanner = {
      name: 'clamav',
      kind: 'engine',
      probe: async () => undefined,
      scan: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new ScanError('engine_error');
      },
    };
    const h = harness({
      source: longSource(),
      scanner: delayedEarly,
      sizeBytes: 64 * 1024,
      contentHash: 'irrelevant',
    });
    const outcome = await settleOrStall(h.judge());

    expect(outcome).not.toBe('still pending');
    expect(outcome).toMatchObject({ rejected: { name: 'ScanFailure', failure: 'engine_error' } });
    expect(h.promotion.aborted).toBe(1);
    expect(h.promotion.committed).toBe(0);
    expect(h.scannerInput()?.destroyed).toBe(true);
    expect(h.source.destroyed).toBe(true);
  });

  it('still promotes a clean object whose digest matches: the fix leaves the happy path alone', async () => {
    const bytes = Buffer.from('hello, scanner');
    const digest = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const h = harness({
      source: Readable.from([bytes]),
      sizeBytes: bytes.length,
      contentHash: digest,
    });

    await expect(h.judge()).resolves.toBe('ready');
    expect(h.promotion.committed).toBe(1);
    expect(h.promotion.aborted).toBe(0);
    expect(h.transitions).toEqual(['ready']);
    expect(h.withdrawn).toEqual([]);
  });
});
