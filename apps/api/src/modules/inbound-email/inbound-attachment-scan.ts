import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { uuidv7 } from '@tmanage/domain';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore, Promotion } from '@tmanage/storage';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ScannerUnavailableError } from '../../common/scan/malware-scanner.js';
import type { MalwareScanner, ScanResult } from '../../common/scan/malware-scanner.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { STALE_SCAN_CLAIM_MS } from '../files/file-scanner.js';
import type {
  InboundAttachmentsRepository,
  ScanCandidate,
} from './inbound-attachments.repository.js';
import { attachmentObjectKey } from './inbound-mail-rules.js';

/**
 * R22-d (54-12a part 2) — the in-process scan pass over parked inbound attachments.
 *
 * Slice c parks the bytes of a DMARC-passing mail's allowed attachment in the `quarantine` zone
 * under `attachmentObjectKey(org, address, attachment)` with its `sha256`, and leaves the row
 * `scanning`. This pass, per claimed row ({@link InboundAttachmentsRepository.claimScanning}),
 * reads the quarantine object ONCE and feeds the same chunks to the SHA-256 digest (held to the
 * row's — bytes that changed under us are `unavailable`, never a verdict), the scanner (30 s per
 * file, rule 8) and the promotion's sink in the `private` zone (the `file-scanner.ts` pattern):
 *
 * - `clean` -> the promotion is committed, `recordClean` + audit `inbound_email.attachment_clean`
 *   in one transaction, then the quarantine copy is removed;
 * - `infected` -> the promotion is aborted, the quarantine object removed, `recordThreat` + audit
 *   `inbound_email.attachment_blocked` + outbox `inbound_email.attachment_blocked.v1` (56-23 reads
 *   it later; the API has no `security_signals` writer — stated). The engine's detection name goes
 *   to stderr only;
 * - the object missing, its size or digest not the row's -> `unavailable` (ask the sender to
 *   re-send), counted as an error;
 * - the scanner unreachable ({@link ScannerUnavailableError}) -> the promotion is aborted, the row
 *   stays `scanning` with its claim standing, so it is retried after {@link STALE_SCAN_CLAIM_MS};
 *   the pass stops (an outage is one line, not one per row);
 * - any other scan failure (a timeout, a protocol error) -> the same: the row waits out the bound.
 *
 * A `none` scanner deployment never produces `clean` (rule 3): the pass logs `scanner: none` and
 * claims nothing, so every row stays `scanning` and its preview/download stay 404.
 *
 * Not built here (stated): PDF structure hardening and OOXML part listing (no `pdf-lib` and no ZIP
 * reader in the API — a PDF is scanned, never parsed; slice c's head check stays the type gate),
 * the 90-day purge of never-trusted held mail, and linking clean files as file versions.
 */

export const INBOUND_SCAN_POLICY = 'inbound-attachment-scan';
export const INBOUND_SCAN_REASON =
  'finding which organizations hold parked inbound e-mail attachments awaiting a malware scan, ' +
  'so each can be judged under its own service context (54-12a)';
/** 54-12a rule 8: 30 s per file. */
export const SCAN_TIMEOUT_MS = 30_000;
export const INBOUND_SCAN_BATCH = 25;
const MAX_BATCHES_PER_ORGANIZATION = 20;

export interface InboundScanReport {
  readonly scanned: number;
  readonly clean: number;
  readonly infected: number;
  /** Rows marked `unavailable`, plus rows left `scanning` because the scanner was down. */
  readonly unavailable: number;
  readonly errors: number;
}

export interface InboundScanDeps {
  readonly database: TenantDatabase;
  readonly store: ObjectStore;
  readonly scanner: MalwareScanner;
  readonly repository: InboundAttachmentsRepository;
  readonly audit: AuditService | null;
  readonly outbox: OutboxEventsRepository | null;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  readonly timeoutMs?: number;
}

type RowOutcome = 'clean' | 'infected' | 'unavailable' | 'deferred' | 'outage' | 'skipped';

class Unavailable extends Error {
  constructor(readonly reason: string) {
    super(`attachment unavailable: ${reason}`);
    this.name = 'Unavailable';
  }
}

class Deferred extends Error {
  constructor(readonly reason: string) {
    super(`attachment scan deferred: ${reason}`);
    this.name = 'Deferred';
  }
}

const PREVIEW_SIGNATURES: readonly {
  readonly type: string;
  readonly match: (head: Buffer) => boolean;
}[] = [
  {
    type: 'image/png',
    match: (h) =>
      h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { type: 'image/jpeg', match: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff },
  {
    type: 'image/gif',
    match: (h) => {
      const sig = h.subarray(0, 6).toString('latin1');
      return sig === 'GIF87a' || sig === 'GIF89a';
    },
  },
  {
    type: 'image/webp',
    match: (h) =>
      h.subarray(0, 4).toString('latin1') === 'RIFF' &&
      h.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  { type: 'application/pdf', match: (h) => h.subarray(0, 5).toString('latin1') === '%PDF-' },
];

/** The previewable types (54-12a rule 4): images and PDFs only. */
export const PREVIEW_TYPES: ReadonlySet<string> = new Set(PREVIEW_SIGNATURES.map((s) => s.type));

/** The detected type of a previewable head, or `null` for anything else (served as a download only). */
export function sniffPreviewType(head: Buffer): string | null {
  for (const signature of PREVIEW_SIGNATURES) if (signature.match(head)) return signature.type;
  return null;
}

export function inboundScanContext(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: INBOUND_SCAN_POLICY,
  });
}

export async function runInboundAttachmentPass(deps: InboundScanDeps): Promise<InboundScanReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.warn(line));
  const counts = { scanned: 0, clean: 0, infected: 0, unavailable: 0, errors: 0 };
  if (deps.scanner.kind === 'none') {
    // Rule 3: without a scanner nothing is ever `clean`; rows stay `scanning`, routes stay 404.
    log('[inbound-scan] scanner: none — attachments stay scanning');
    return counts;
  }
  try {
    await deps.scanner.probe();
  } catch (error) {
    log(`[inbound-scan] scanner unreachable: ${describe(error)}`);
    return counts;
  }

  const correlationId = uuidv7();
  const staleBefore = new Date(now().getTime() - STALE_SCAN_CLAIM_MS);
  const organizations = await deps.database.bootstrapRead(
    { correlationId, reason: INBOUND_SCAN_REASON, tables: ['inbound_email_attachments'] },
    (db) => deps.repository.organizationsAwaitingScan(db, staleBefore),
  );

  for (const organizationId of organizations) {
    const listContext = inboundScanContext(organizationId, correlationId);
    for (let batch = 0; batch < MAX_BATCHES_PER_ORGANIZATION; batch += 1) {
      const rows = await deps.database.read(listContext, (db) =>
        deps.repository.listAwaitingScan(db, listContext, staleBefore, INBOUND_SCAN_BATCH),
      );
      let moved = 0;
      for (const row of rows) {
        const context = inboundScanContext(organizationId, uuidv7());
        const outcome = await scanOne(deps, context, row, staleBefore, now, log);
        if (outcome === 'skipped') continue;
        counts.scanned += 1;
        if (outcome === 'clean') counts.clean += 1;
        else if (outcome === 'infected') counts.infected += 1;
        else if (outcome === 'unavailable') {
          counts.unavailable += 1;
          counts.errors += 1;
        } else if (outcome === 'outage') {
          // The scanner went away mid-pass: the row waits out the bound, and the pass stops.
          counts.unavailable += 1;
          return counts;
        } else {
          // `deferred`: a timeout or a store error; the row waits out the stale bound.
          counts.unavailable += 1;
          counts.errors += 1;
        }
        moved += 1;
      }
      if (rows.length < INBOUND_SCAN_BATCH || moved === 0) break;
    }
  }
  return counts;
}

async function scanOne(
  deps: InboundScanDeps,
  context: TenantContext,
  row: ScanCandidate,
  staleBefore: Date,
  now: () => Date,
  log: (line: string) => void,
): Promise<RowOutcome> {
  const claimed = await deps.database.transaction(context, (tx) =>
    deps.repository.claimScanning(tx, context, row, staleBefore, now()),
  );
  if (!claimed) return 'skipped';
  const objectKey = attachmentObjectKey(context.organizationId, row.addressId, row.id);
  try {
    const judged = await judge(deps, row, objectKey);
    if (judged.result.verdict === 'infected') {
      await quietly(() => deps.store.remove({ zone: 'quarantine', objectKey }), log);
      await deps.database.transaction(context, async (tx) => {
        const recorded = await deps.repository.recordThreat(tx, context, row.id, {
          scanner: deps.scanner.name,
          detectedType: judged.detectedType,
          at: now(),
        });
        if (!recorded) return;
        await deps.audit?.record(tx, context, {
          action: 'inbound_email.attachment_blocked',
          objectId: row.id,
          result: 'denied',
          actorUserId: null,
          metadata: { scanner: deps.scanner.name, size_bytes: row.sizeBytes, verdict: 'infected' },
        });
        await deps.outbox?.append(tx, context, {
          type: 'inbound_email.attachment_blocked.v1',
          aggregateId: row.id,
          payload: {
            attachmentId: row.id,
            inboundEmailId: row.inboundEmailId,
            scanner: deps.scanner.name,
          },
        });
      });
      // The one place the engine's detection name is written: stderr, for an operator.
      console.error(
        `[inbound-scan] attachment ${row.id} blocked: ${judged.result.detection ?? 'unnamed'} ` +
          `(${context.correlationId})`,
      );
      return 'infected';
    }
    const recorded = await deps.database.transaction(context, async (tx) => {
      const ok = await deps.repository.recordClean(tx, context, row.id, {
        scanner: deps.scanner.name,
        detectedType: judged.detectedType,
        at: now(),
      });
      if (!ok) return false;
      await deps.audit?.record(tx, context, {
        action: 'inbound_email.attachment_clean',
        objectId: row.id,
        result: 'allowed',
        actorUserId: null,
        metadata: { scanner: deps.scanner.name, size_bytes: row.sizeBytes, verdict: 'clean' },
      });
      return true;
    });
    if (!recorded) {
      // Another pass concluded the row first; a private object it did not keep is withdrawn.
      await quietly(() => deps.store.withdraw({ objectKey }), log);
      return 'skipped';
    }
    await quietly(() => deps.store.remove({ zone: 'quarantine', objectKey }), log);
    return 'clean';
  } catch (error) {
    if (error instanceof Unavailable) {
      await deps.database.transaction(context, (tx) =>
        deps.repository.markUnavailable(tx, context, row.id, now()),
      );
      log(`[inbound-scan] attachment ${row.id} unavailable: ${error.reason}`);
      return 'unavailable';
    }
    log(`[inbound-scan] attachment ${row.id} deferred: ${describe(error)}`);
    return error instanceof ScannerUnavailableError ? 'outage' : 'deferred';
  }
}

/** The one read: digest, scanner and promotion sink from the same stream. */
async function judge(
  deps: InboundScanDeps,
  row: ScanCandidate,
  objectKey: string,
): Promise<{ readonly result: ScanResult; readonly detectedType: string | null }> {
  if (row.sha256 === null) throw new Unavailable('no_digest');
  let opened;
  try {
    opened = await deps.store.openObject({ zone: 'quarantine', objectKey });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw new Unavailable('object_not_found');
    throw new Deferred('store_error');
  }
  if (opened.sizeBytes !== row.sizeBytes) {
    destroy(opened.stream);
    throw new Unavailable('size_mismatch');
  }
  let promotion: Promotion;
  try {
    promotion = await deps.store.promote({ objectKey, sizeBytes: row.sizeBytes });
  } catch {
    destroy(opened.stream);
    throw new Deferred('store_error');
  }
  const sink = promotion.sink as NodeJS.WritableStream & {
    on?: (e: string, l: () => void) => void;
  };
  sink.on?.('error', () => undefined);

  const toScanner = new PassThrough();
  toScanner.on('error', () => undefined);
  const signal = AbortSignal.timeout(deps.timeoutMs ?? SCAN_TIMEOUT_MS);
  const timedOut = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Deferred('timeout')), { once: true });
  });
  // The engine's settlement, watched from the start: once it has answered (or failed, or the
  // 30 s ran out) nothing drains the tee, so it is destroyed and a blocked write fails at once.
  let engineFailure: unknown = null;
  const engine: Promise<ScanResult> = Promise.race([
    deps.scanner.scan({ stream: toScanner, sizeBytes: row.sizeBytes }),
    timedOut,
  ]);
  engine.then(
    () => destroyIfOpen(toScanner),
    (failure: unknown) => {
      engineFailure = failure ?? new Deferred('engine_error');
      destroyIfOpen(toScanner);
    },
  );

  const hash = createHash('sha256');
  let head = Buffer.alloc(0);
  let size = 0;
  let result: ScanResult;
  try {
    try {
      for await (const piece of opened.stream) {
        if (engineFailure !== null) break;
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
        size += chunk.length;
        if (size > row.sizeBytes) throw new Unavailable('size_mismatch');
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
        await writeTo(promotion.sink, chunk);
        if (!toScanner.destroyed) await writeTo(toScanner, chunk);
      }
      if (!toScanner.destroyed) toScanner.end();
      result = await engine;
    } catch (error) {
      destroy(opened.stream);
      destroyIfOpen(toScanner);
      if (error instanceof Unavailable) throw error;
      // The engine's own failure (unreachable, timed out) is the more precise cause.
      if (engineFailure instanceof ScannerUnavailableError) throw engineFailure;
      if (engineFailure instanceof Deferred) throw engineFailure;
      if (error instanceof ScannerUnavailableError || error instanceof Deferred) throw error;
      throw new Deferred(engineFailure !== null ? 'engine_error' : 'stream_error');
    }
    if (size !== row.sizeBytes) throw new Unavailable('size_mismatch');
    if (hash.digest('hex') !== row.sha256) throw new Unavailable('hash_mismatch');
  } catch (error) {
    await abortQuietly(promotion);
    throw error;
  }

  if (result.verdict === 'infected') {
    await abortQuietly(promotion);
    return { result, detectedType: sniffPreviewType(head) ?? row.detectedType };
  }
  try {
    await promotion.commit();
  } catch {
    throw new Deferred('store_error');
  }
  return { result, detectedType: sniffPreviewType(head) ?? row.detectedType };
}

async function abortQuietly(promotion: Promotion): Promise<void> {
  try {
    await promotion.abort();
  } catch {
    // The staged write is the next conclusion's to remove.
  }
}

async function quietly(work: () => Promise<void>, log: (line: string) => void): Promise<void> {
  try {
    await work();
  } catch (error) {
    log(`[inbound-scan] store cleanup failed: ${describe(error)}`);
  }
}

function writeTo(sink: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      sink.off('error', onError);
      sink.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error('the sink closed before this write settled'));
    sink.once('error', onError);
    sink.once('close', onClose);
    sink.write(chunk, (error) => finish(error ?? null));
  });
}

function destroy(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  const candidate = stream as { destroy?: () => void; destroyed?: boolean };
  if (typeof candidate.destroy === 'function' && !candidate.destroyed) candidate.destroy();
}

function destroyIfOpen(stream: PassThrough): void {
  if (!stream.writableEnded && !stream.destroyed) stream.destroy();
}

function describe(error: unknown): string {
  if (error instanceof Unavailable || error instanceof Deferred) return error.reason;
  if (error instanceof Error) return error.name;
  return 'unknown';
}

/** The one line a pass prints. */
export function describeInboundScan(report: InboundScanReport): string {
  return (
    `scanned ${report.scanned}, clean ${report.clean}, infected ${report.infected}, ` +
    `unavailable ${report.unavailable}, errors ${report.errors}`
  );
}
