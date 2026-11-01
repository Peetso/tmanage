import { createHash } from 'node:crypto';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FigmaFrameRow, FigmaLinkRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { FigmaRepository } from './figma.repository.js';
import {
  FigmaAuthError,
  FigmaNotFoundError,
  FigmaRateLimitError,
  snapshotScale,
  type FigmaRestClient,
} from './figma.rest.js';
import { figmaSnapshotObjectKey, figmaTokenBinding } from './figma.service.js';

/**
 * R4 slice 13 — the Figma snapshot job (SPEC R4 §3.5.2), the preview job's shape: off unless this
 * process runs background work (`WORKER_INPROCESS=1`, or `FIGMA_SNAPSHOT_INPROCESS=1` /
 * `FILE_PREVIEW_INPROCESS=1` for a local API); once shortly after boot; on an interval; and on
 * request (a new link, "Refresh snapshots").
 *
 * One pass: every organization with pending frames nobody holds; per organization, a batch of
 * frames grouped by link; per link, the **link creator's** token (the member who attached it —
 * SPEC also allows "any connected member on the project"; not done here, so nobody's token reads
 * a link they did not attach), one `nodes` call for the current sizes, one `images` call for the
 * render URLs, then each PNG is downloaded, hashed (SHA-256) and stored in the `derived` zone. A
 * size other than the last snapshot's sets `size_changed` ("Frame changed").
 *
 * Failures: Figma's 429 releases the claims and ends the pass (the next tick tries again); a
 * refused token or a file the creator can no longer open fails the link's frames at once; any
 * other fault counts an attempt (`failed` after 3).
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
  readonly batchSize: number;
  readonly claimStaleMs: number;
  readonly log: (line: string) => void;
}

export const DEFAULT_FIGMA_SNAPSHOT_JOB_OPTIONS: FigmaSnapshotJobOptions = {
  bootDelayMs: 12_000,
  intervalMs: 3 * 60_000,
  debounceMs: 1_500,
  batchSize: 20,
  claimStaleMs: 10 * 60_000,
  log: (line) => console.warn(line),
};

export function figmaSnapshotJobEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env['WORKER_INPROCESS'] === '1' ||
    env['FIGMA_SNAPSHOT_INPROCESS'] === '1' ||
    env['FILE_PREVIEW_INPROCESS'] === '1'
  );
}

export interface FigmaSnapshotReport {
  readonly organizations: number;
  readonly ready: number;
  readonly failed: number;
  readonly retrying: number;
  readonly rateLimited: boolean;
}

class RateLimited extends Error {}

export class FigmaSnapshotJob implements OnApplicationBootstrap, OnModuleDestroy {
  private running: Promise<FigmaSnapshotReport> | null = null;
  private again = false;
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
    do {
      this.again = false;
      this.running = this.pass();
      try {
        const report = await this.running;
        if (report.ready + report.failed + report.retrying > 0 || report.rateLimited) {
          this.options.log(`[figma] pass: ${JSON.stringify(report)}`);
        }
      } catch (error) {
        this.options.log(
          `[figma] pass failed: ${error instanceof Error ? error.name : 'unknown error'}`,
        );
      } finally {
        this.running = null;
      }
    } while (this.again && !this.stopped);
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
    const tally = { ready: 0, failed: 0, retrying: 0 };
    const organizations = await this.database.bootstrapRead(
      { correlationId, reason: FIGMA_SNAPSHOT_REASON, tables: ['figma_frames'] },
      (db) => this.repository.organizationsWithPendingFrames(db, staleBefore),
    );
    try {
      for (const organizationId of organizations) {
        const context = createServiceContext({
          organizationId,
          correlationId,
          policyVersion: FIGMA_SNAPSHOT_POLICY_VERSION,
        });
        await this.drawOrganization(context, staleBefore, tally);
      }
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error;
      return { organizations: organizations.length, ...tally, rateLimited: true };
    }
    return { organizations: organizations.length, ...tally, rateLimited: false };
  }

  private async drawOrganization(
    context: TenantContext,
    staleBefore: Date,
    tally: { ready: number; failed: number; retrying: number },
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

  private async drawLink(
    context: TenantContext,
    link: FigmaLinkRow | undefined,
    frames: readonly FigmaFrameRow[],
    tally: { ready: number; failed: number; retrying: number },
    remaining: Set<string>,
  ): Promise<void> {
    const failAll = async (final: boolean) => {
      for (const frame of frames) {
        await this.database.transaction(context, (tx) =>
          this.repository.recordSnapshotFailure(tx, context, frame, final, this.now()),
        );
        remaining.delete(frame.id);
        if (final) tally.failed += 1;
        else tally.retrying += 1;
      }
    };
    // A removed link's frames are not drawn.
    if (!link || link.deletedAt !== null) return failAll(true);
    const token = await this.tokenOf(context, link.createdByMembershipId);
    if (!token) return failAll(true);

    let sizes: ReadonlyMap<string, { width: number; height: number }>;
    let urls: ReadonlyMap<string, string | null>;
    try {
      const nodeIds = frames.map((frame) => frame.nodeId);
      const found = await this.rest.nodes(token, link.fileKey, nodeIds);
      sizes = new Map(found.nodes.map((node) => [node.nodeId, node]));
      const scale = Math.min(
        ...frames.map((frame) => {
          const size = sizes.get(frame.nodeId);
          return snapshotScale(size?.width ?? frame.width, size?.height ?? frame.height);
        }),
      );
      urls = await this.rest.renderUrls(token, link.fileKey, nodeIds, scale);
    } catch (error) {
      if (error instanceof FigmaRateLimitError) throw new RateLimited();
      if (error instanceof FigmaAuthError || error instanceof FigmaNotFoundError) {
        if (error instanceof FigmaAuthError && error.status === 401) {
          await this.database.transaction(context, (tx) =>
            this.repository.markConnectionError(tx, context, link.createdByMembershipId),
          );
        }
        return failAll(true);
      }
      return failAll(false);
    }

    for (const frame of frames) {
      const size = sizes.get(frame.nodeId);
      const url = urls.get(frame.nodeId) ?? null;
      if (!size || !url) {
        await this.database.transaction(context, (tx) =>
          this.repository.recordSnapshotFailure(tx, context, frame, true, this.now()),
        );
        remaining.delete(frame.id);
        tally.failed += 1;
        continue;
      }
      try {
        const bytes = await this.rest.download(url);
        const objectKey = figmaSnapshotObjectKey(context.organizationId, link.id, frame.id);
        await this.store.putDerivative({ objectKey, body: bytes });
        const hash = createHash('sha256').update(bytes).digest('hex');
        const sizeChanged =
          frame.sizeChanged ||
          (frame.capturedAt !== null &&
            frame.width > 0 &&
            (frame.width !== size.width || frame.height !== size.height));
        await this.database.transaction(context, async (tx) => {
          const written = await this.repository.markSnapshotReady(
            tx,
            context,
            frame.id,
            { objectKey, hash, width: size.width, height: size.height, sizeChanged },
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
                width: size.width,
                height: size.height,
                size_changed: sizeChanged,
              },
            });
          }
        });
        remaining.delete(frame.id);
        tally.ready += 1;
      } catch (error) {
        if (error instanceof FigmaRateLimitError) throw new RateLimited();
        await this.database.transaction(context, (tx) =>
          this.repository.recordSnapshotFailure(tx, context, frame, false, this.now()),
        );
        remaining.delete(frame.id);
        tally.retrying += 1;
      }
    }
  }

  private async tokenOf(context: TenantContext, membershipId: string): Promise<string | null> {
    const row = await this.database.read(context, (db) =>
      this.repository.findConnection(db, context, membershipId),
    );
    if (!row || row.status !== 'connected') return null;
    try {
      return this.cipher.decrypt(
        row.tokenCiphertext,
        figmaTokenBinding(context.organizationId, membershipId),
      );
    } catch {
      return null;
    }
  }
}
