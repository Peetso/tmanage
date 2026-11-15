import { createHash } from 'node:crypto';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FigmaFrameRow, FigmaLinkRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { imageGenerator } from '../files/preview-generators/image.js';
import { DEFAULT_PREVIEW_LIMITS } from '../files/preview-generators/types.js';
import { FigmaRepository, type FigmaSnapshotError } from './figma.repository.js';
import {
  FigmaAuthError,
  FigmaNotFoundError,
  FigmaRateLimitError,
  FigmaUnavailableError,
  figmaWaitMs,
  snapshotScale,
  type FigmaRestClient,
} from './figma.rest.js';
import { figmaSnapshotObjectKey, figmaThumbObjectKey, readMemberToken } from './figma.service.js';

/**
 * R4 slice 13, reworked 2026-11-10 — the Figma snapshot job (SPEC R4 §3.5.2), the preview job's
 * shape: once shortly after boot, on an interval, on request (a new link, "Refresh from Figma",
 * a change of pages), and again straight after any pass that drew something, so a whole file is
 * captured in background batches without blocking anyone.
 *
 * On in the single Hostinger process (its start file turns `FIGMA_SNAPSHOT_INPROCESS` on unless
 * it is set to `0`), and wherever background work runs (`WORKER_INPROCESS=1`); off in suites.
 *
 * One pass: every organization with pending frames nobody holds; per organization, a batch of
 * frames in capture order (the frame the link pointed at, its page, then the rest); per link,
 * the **link creator's** token, one `images` call per render scale (at most
 * {@link RENDERS_PER_REQUEST} ids each), then each PNG is downloaded, hashed (SHA-256) and stored in
 * the `derived` zone beside a small WebP of it (the whole-page view). The frame's size is the one
 * its outline gave ("Frame changed" is decided when the outline is read again).
 *
 * Failures are honest: each records why (`snapshot_error`) so the team's screen can say it.
 * Figma's 429 releases the claims and ends the pass (the next tick tries again); a refused token,
 * a file the creator can no longer open or a frame Figma no longer has fails at once; any other
 * fault counts an attempt (`failed` after 3).
 */

export const FIGMA_SNAPSHOT_JOB = Symbol.for('tmanage.FigmaSnapshotJob');

export const FIGMA_SNAPSHOT_POLICY_VERSION = 'figma-snapshot';

export const FIGMA_SNAPSHOT_REASON =
  'finding which organizations hold pending Figma frame snapshots, or claims gone stale, so ' +
  'each can be drawn under its own service context (R4 slice 13)';

export interface FigmaSnapshotJobOptions {
  readonly bootDelayMs: number;
  readonly intervalMs: number;
  readonly debounceMs: number;
  /** The pause before the next batch when a pass drew something. */
  readonly continueMs: number;
  readonly batchSize: number;
  readonly claimStaleMs: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_FIGMA_SNAPSHOT_JOB_OPTIONS: FigmaSnapshotJobOptions = {
  bootDelayMs: 12_000,
  intervalMs: 3 * 60_000,
  debounceMs: 1_500,
  continueMs: 3_000,
  batchSize: 20,
  claimStaleMs: 10 * 60_000,
  log: (line) => console.warn(line),
};

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

export function figmaSnapshotJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const own = env['FIGMA_SNAPSHOT_INPROCESS'];
  if (own !== undefined && OFF_VALUES.has(own.trim().toLowerCase())) return false;
  return env['WORKER_INPROCESS'] === '1' || own === '1' || env['FILE_PREVIEW_INPROCESS'] === '1';
}

export interface FigmaSnapshotReport {
  readonly organizations: number;
  readonly ready: number;
  readonly failed: number;
  readonly retrying: number;
  readonly rateLimited: boolean;
}

interface Tally {
  ready: number;
  failed: number;
  retrying: number;
}

class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('rate limited');
    this.name = 'RateLimited';
  }
}

/**
 * Ids per `images` call. Figma renders every id of a call before it answers, and a call of 20
 * large frames can pass the 30-second request limit (2026-11-15 live test: nothing arrived), so
 * renders go in smaller calls.
 */
export const RENDERS_PER_REQUEST = 8;

/** Why a Figma call failed, as the token the team's screen words, and whether to stop trying. */
export function snapshotErrorOf(error: unknown): {
  readonly reason: FigmaSnapshotError;
  readonly final: boolean;
} {
  if (error instanceof FigmaAuthError) {
    return { reason: error.status === 401 ? 'no_connection' : 'no_access', final: true };
  }
  if (error instanceof FigmaNotFoundError) return { reason: 'not_found', final: true };
  if (error instanceof FigmaUnavailableError && error.detail === 'snapshot_too_large') {
    return { reason: 'too_large', final: true };
  }
  return { reason: 'unreachable', final: false };
}

/** A small WebP of the snapshot for the whole-page view, or null when it cannot be made. */
export async function snapshotThumb(png: Uint8Array): Promise<Uint8Array | null> {
  try {
    const [outcome] = await imageGenerator.generate(
      { bytes: png, mimeType: 'image/png' },
      [{ kind: 'thumb', pageNo: 0 }],
      DEFAULT_PREVIEW_LIMITS,
    );
    return outcome?.status === 'ready' && outcome.body ? outcome.body : null;
  } catch {
    return null;
  }
}

export class FigmaSnapshotJob implements OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<FigmaSnapshotReport> | null = null;
  private again = false;
  /**
   * Security review M1 (2026-11-14): a workspace Figma refused (429) waits until here, alone; the
   * others go on. The first workspace of a pass rotates so none is always last.
   */
  private readonly limitedUntil = new Map<string, number>();
  private rotation = 0;
  private pending: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly database: TenantDatabase,
    private readonly store: ObjectStore,
    private readonly rest: FigmaRestClient,
    private readonly cipher: SeedCipher,
    private readonly audit: AuditService | null,
    private readonly enabled: boolean,
    private readonly options: FigmaSnapshotJobOptions = DEFAULT_FIGMA_SNAPSHOT_JOB_OPTIONS,
    private readonly repository: FigmaRepository = new FigmaRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.schedule(this.options.bootDelayMs);
    this.interval = setInterval(() => this.request(), this.options.intervalMs);
    this.interval.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.pending) clearTimeout(this.pending);
    if (this.interval) clearInterval(this.interval);
    this.pending = null;
    this.interval = null;
    await this.running?.catch(() => undefined);
  }

  request(): void {
    if (!this.enabled || this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.schedule(this.options.debounceMs);
  }

  async runNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      await this.running.catch(() => undefined);
      return;
    }
    let drew = false;
    do {
      this.again = false;
      this.running = this.pass();
      try {
        const report = await this.running;
        drew = report.ready + report.retrying > 0;
        if (report.ready + report.failed + report.retrying > 0 || report.rateLimited) {
          this.options.log(`[figma] pass: ${JSON.stringify(report)}`);
        }
      } catch (error) {
        drew = false;
        this.options.log(
          `[figma] pass failed: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
      } finally {
        this.running = null;
      }
    } while (this.again && !this.stopped);
    // More of the file may be waiting: the next batch after a short pause.
    if (drew && this.enabled) this.schedule(this.options.continueMs);
  }

  private schedule(delayMs: number): void {
    if (this.pending || this.stopped) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.runNow();
    }, delayMs);
    this.pending.unref();
  }

  async pass(): Promise<FigmaSnapshotReport> {
    const correlationId = uuidv7();
    const staleBefore = new Date(this.now().getTime() - this.options.claimStaleMs);
    const tally: Tally = { ready: 0, failed: 0, retrying: 0 };
    const organizations = await this.database.bootstrapRead(
      { correlationId, reason: FIGMA_SNAPSHOT_REASON, tables: ['figma_frames'] },
      (db) => this.repository.organizationsWithPendingFrames(db, staleBefore),
    );
    const start = organizations.length === 0 ? 0 : this.rotation % organizations.length;
    this.rotation += 1;
    const order = [...organizations.slice(start), ...organizations.slice(0, start)];
    let rateLimited = false;
    for (const organizationId of order) {
      const until = this.limitedUntil.get(organizationId);
      if (until !== undefined && until > this.now().getTime()) {
        rateLimited = true;
        continue;
      }
      this.limitedUntil.delete(organizationId);
      const context = createServiceContext({
        organizationId,
        correlationId,
        policyVersion: FIGMA_SNAPSHOT_POLICY_VERSION,
      });
      try {
        await this.drawOrganization(context, staleBefore, tally);
      } catch (error) {
        if (!(error instanceof RateLimited)) throw error;
        // This workspace waits; the next one is drawn now.
        rateLimited = true;
        this.limitedUntil.set(
          organizationId,
          this.now().getTime() + figmaWaitMs(error.retryAfterSeconds),
        );
      }
    }
    return { organizations: organizations.length, ...tally, rateLimited };
  }

  private async drawOrganization(
    context: TenantContext,
    staleBefore: Date,
    tally: Tally,
  ): Promise<void> {
    const listed = await this.database.read(context, (db) =>
      this.repository.listPendingFrames(db, context, staleBefore, this.options.batchSize),
    );
    if (listed.length === 0) return;
    const claimed: FigmaFrameRow[] = [];
    for (const frame of listed) {
      const ok = await this.database.transaction(context, (tx) =>
        this.repository.claimFrame(tx, context, frame, this.now(), staleBefore),
      );
      if (ok) claimed.push(frame);
    }
    const links = await this.database.read(context, (db) =>
      this.repository.findLinks(
        db,
        context,
        claimed.map((frame) => frame.linkId),
      ),
    );
    const byLink = new Map<string, FigmaFrameRow[]>();
    for (const frame of claimed) {
      const group = byLink.get(frame.linkId) ?? [];
      group.push(frame);
      byLink.set(frame.linkId, group);
    }
    const remaining = new Set(claimed.map((frame) => frame.id));
    try {
      for (const [linkId, frames] of byLink) {
        const link = links.find((row) => row.id === linkId);
        await this.drawLink(context, link, frames, tally, remaining);
      }
    } catch (error) {
      if (error instanceof RateLimited) {
        for (const id of remaining) {
          await this.database.transaction(context, (tx) =>
            this.repository.releaseFrame(tx, context, id),
          );
        }
      }
      throw error;
    }
  }

  private async fail(
    context: TenantContext,
    frame: FigmaFrameRow,
    reason: FigmaSnapshotError,
    final: boolean,
    tally: Tally,
    remaining: Set<string>,
  ): Promise<void> {
    await this.database.transaction(context, (tx) =>
      this.repository.recordSnapshotFailure(tx, context, frame, final, this.now(), reason),
    );
    remaining.delete(frame.id);
    if (final || frame.snapshotAttempts + 1 >= 3) tally.failed += 1;
    else tally.retrying += 1;
  }

  private async drawLink(
    context: TenantContext,
    link: FigmaLinkRow | undefined,
    frames: readonly FigmaFrameRow[],
    tally: Tally,
    remaining: Set<string>,
  ): Promise<void> {
    const failAll = async (reason: FigmaSnapshotError, final: boolean) => {
      for (const frame of frames) {
        await this.fail(context, frame, reason, final, tally, remaining);
      }
    };
    // A removed link's frames are not drawn.
    if (!link || link.deletedAt !== null) return failAll('not_found', true);
    // Figma asked to wait (a 429 seen by any process): not asked again before then.
    const waitLeft = (link.figmaWaitUntil?.getTime() ?? 0) - this.now().getTime();
    if (waitLeft > 0) throw new RateLimited(Math.ceil(waitLeft / 1000));
    const token = await readMemberToken(
      this.database,
      this.repository,
      this.cipher,
      context,
      link.createdByMembershipId,
    );
    if (!token) return failAll('no_connection', true);

    // One `images` call per scale, a bounded number of ids each.
    const groups = new Map<number, FigmaFrameRow[]>();
    for (const frame of frames) {
      const scale = snapshotScale(frame.width, frame.height);
      const group = groups.get(scale) ?? [];
      group.push(frame);
      groups.set(scale, group);
    }
    for (const [scale, group] of groups) {
      for (let at = 0; at < group.length; at += RENDERS_PER_REQUEST) {
        const batch = group.slice(at, at + RENDERS_PER_REQUEST);
        let urls: ReadonlyMap<string, string | null>;
        try {
          urls = await this.rest.renderUrls(
            token,
            link.fileKey,
            batch.map((frame) => frame.nodeId),
            scale,
          );
        } catch (error) {
          if (error instanceof FigmaRateLimitError) {
            throw await this.waitForFigma(context, link, error.retryAfterSeconds);
          }
          if (error instanceof FigmaAuthError && error.status === 401) {
            await this.database.transaction(context, (tx) =>
              this.repository.markConnectionError(tx, context, link.createdByMembershipId),
            );
          }
          const { reason, final } = snapshotErrorOf(error);
          for (const frame of batch) {
            await this.fail(context, frame, reason, final, tally, remaining);
          }
          continue;
        }
        for (const frame of batch) {
          await this.drawFrame(
            context,
            link,
            frame,
            urls.get(frame.nodeId) ?? null,
            tally,
            remaining,
          );
        }
      }
    }
  }

  /** Figma's 429: the link waits (in its row, for every process and the team's screen). */
  private async waitForFigma(
    context: TenantContext,
    link: FigmaLinkRow,
    retryAfterSeconds: number,
  ): Promise<RateLimited> {
    const until = new Date(this.now().getTime() + figmaWaitMs(retryAfterSeconds));
    await this.database.transaction(context, (tx) =>
      this.repository.setFigmaWait(tx, context, link.id, until),
    );
    return new RateLimited(retryAfterSeconds);
  }

  private async drawFrame(
    context: TenantContext,
    link: FigmaLinkRow,
    frame: FigmaFrameRow,
    url: string | null,
    tally: Tally,
    remaining: Set<string>,
  ): Promise<void> {
    // Figma answers no render for a node it no longer has.
    if (!url) return this.fail(context, frame, 'not_found', true, tally, remaining);
    try {
      const bytes = await this.rest.download(url);
      const objectKey = figmaSnapshotObjectKey(context.organizationId, link.id, frame.id);
      await this.store.putDerivative({ objectKey, body: bytes });
      const thumb = await snapshotThumb(bytes);
      if (thumb) {
        await this.store.putDerivative({ objectKey: figmaThumbObjectKey(objectKey), body: thumb });
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      await this.database.transaction(context, async (tx) => {
        const written = await this.repository.markSnapshotReady(
          tx,
          context,
          frame.id,
          { objectKey, hash, width: frame.width, height: frame.height, hasThumb: thumb !== null },
          this.now(),
        );
        if (written && this.audit) {
          await this.audit.record(tx, context, {
            action: 'figma.snapshot_taken',
            objectId: frame.id,
            result: 'allowed',
            metadata: {
              figma_link_id: link.id,
              project_id: link.projectId,
              width: frame.width,
              height: frame.height,
              size_changed: frame.sizeChanged,
            },
          });
        }
      });
      remaining.delete(frame.id);
      tally.ready += 1;
    } catch (error) {
      if (error instanceof FigmaRateLimitError) {
        throw await this.waitForFigma(context, link, error.retryAfterSeconds);
      }
      const { reason, final } = snapshotErrorOf(error);
      await this.fail(context, frame, reason, final, tally, remaining);
    }
  }
}
