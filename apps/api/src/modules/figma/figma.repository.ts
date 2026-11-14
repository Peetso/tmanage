import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientRequests,
  deliverableVersions,
  deliverables,
  fileAssets,
  figmaConnections,
  figmaFrames,
  figmaLinks,
  workItems,
} from '../../common/database/schema.js';
import type {
  FigmaConnectionRow,
  FigmaFrameRow,
  FigmaLinkRow,
} from '../../common/database/schema.js';
import type { FrameDiff, FramePlacement, PlannedFrame } from './figma-outline.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * R4 slice 13 — the data half of Figma links (0270). Every query carries
 * `organization_id = context.organizationId`; `organization_id` is never taken from input. The
 * one cross-tenant read ({@link FigmaRepository.organizationsWithPendingFrames}) goes through the
 * bootstrap runner, as the preview job's does.
 */

export const FIGMA_LINK_AUDIENCES = ['internal', 'client_visible'] as const;
export type FigmaLinkAudience = (typeof FIGMA_LINK_AUDIENCES)[number];

/**
 * `deliverable`: the deliverable itself, before or after any version. `file_asset`: an uploaded
 * `.fig` paired with its Figma file ("Show it from Figma").
 */
export const FIGMA_ATTACH_TARGETS = [
  'work_item',
  'deliverable',
  'deliverable_version',
  'request',
  'file_asset',
] as const;
export type FigmaAttachTarget = (typeof FIGMA_ATTACH_TARGETS)[number];

/** `skipped`: listed, beyond what the link captures (MAX_CAPTURED_FRAMES, or a page left out). */
export type FigmaSnapshotStatus = 'pending' | 'ready' | 'failed' | 'skipped';

/** Why a capture failed, for the team's screen. */
export type FigmaSnapshotError =
  'no_connection' | 'no_access' | 'not_found' | 'too_large' | 'unreachable';

/** The most snapshot attempts a frame gets before it is `failed` (a manual refresh resets). */
export const FIGMA_SNAPSHOT_MAX_ATTEMPTS = 3;

export interface InsertLinkInput {
  readonly projectId: string;
  readonly fileKey: string;
  readonly fileName: string | null;
  readonly url: string;
  readonly attachedToType: FigmaAttachTarget | null;
  readonly attachedToId: string | null;
  readonly audience: FigmaLinkAudience;
  readonly createdByMembershipId: string;
  readonly captureMode: 'whole_file' | 'picked';
  readonly focusNodeId: string | null;
  readonly outlineJson: string;
  readonly frames: readonly {
    readonly frame: PlannedFrame;
    readonly placement: FramePlacement;
  }[];
}

/** The most rows one insert statement carries. */
const INSERT_CHUNK = 200;

function frameColumns(frame: PlannedFrame, placement: FramePlacement) {
  return {
    name: frame.name,
    width: frame.width,
    height: frame.height,
    pageId: frame.pageId,
    pageName: frame.pageName,
    sectionName: frame.sectionName,
    posX: frame.x,
    posY: frame.y,
    sortOrder: placement.sortOrder,
    captureRank: placement.captureRank,
  };
}

export interface SnapshotReadyInput {
  readonly objectKey: string;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  /** The small picture beside it was stored too. */
  readonly hasThumb: boolean;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

function unclaimedOrStale(staleBefore: Date) {
  return or(isNull(figmaFrames.claimedAt), lt(figmaFrames.claimedAt, staleBefore));
}

export class FigmaRepository {
  // ── Connections ────────────────────────────────────────────────────────

  async findConnection(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<FigmaConnectionRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(figmaConnections)
      .where(
        and(
          eq(figmaConnections.organizationId, context.organizationId),
          eq(figmaConnections.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Connect or reconnect: one row per member, replaced. */
  async saveConnection(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: {
      readonly membershipId: string;
      readonly tokenCiphertext: string;
      readonly tokenHint: string;
      readonly handle: string | null;
    },
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    const existing = await this.findConnection(runner, context, input.membershipId);
    if (existing) {
      await db
        .update(figmaConnections)
        .set({
          tokenCiphertext: input.tokenCiphertext,
          tokenHint: input.tokenHint,
          figmaUserHandle: input.handle,
          status: 'connected',
          updatedAt: sql`current_timestamp(3)`,
        })
        .where(
          and(
            eq(figmaConnections.organizationId, context.organizationId),
            eq(figmaConnections.id, existing.id),
          ),
        );
      return;
    }
    await db.insert(figmaConnections).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      membershipId: input.membershipId,
      tokenCiphertext: input.tokenCiphertext,
      tokenHint: input.tokenHint,
      figmaUserHandle: input.handle,
      status: 'connected',
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });
  }

  async markConnectionError(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(figmaConnections)
      .set({ status: 'error', updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(figmaConnections.organizationId, context.organizationId),
          eq(figmaConnections.membershipId, membershipId),
        ),
      );
  }

  async deleteConnection(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(figmaConnections)
      .where(
        and(
          eq(figmaConnections.organizationId, context.organizationId),
          eq(figmaConnections.membershipId, membershipId),
        ),
      );
    return affected(result) > 0;
  }

  // ── Links ──────────────────────────────────────────────────────────────

  /** A link and its frames, in one transaction (the caller's). Frames start `pending`. */
  async insertLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertLinkInput,
  ): Promise<string> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(figmaLinks).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      fileKey: input.fileKey,
      fileName: input.fileName,
      url: input.url,
      attachedToType: input.attachedToType,
      attachedToId: input.attachedToId,
      audience: input.audience,
      createdByMembershipId: input.createdByMembershipId,
      captureMode: input.captureMode,
      focusNodeId: input.focusNodeId,
      outlineJson: input.outlineJson,
      syncedAt: sql`current_timestamp(3)`,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });
    await this.insertFrames(runner, context, id, input.frames);
    return id;
  }

  private async insertFrames(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    frames: readonly { readonly frame: PlannedFrame; readonly placement: FramePlacement }[],
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    for (let at = 0; at < frames.length; at += INSERT_CHUNK) {
      await db.insert(figmaFrames).values(
        frames.slice(at, at + INSERT_CHUNK).map(({ frame, placement }) => ({
          id: uuidv7(),
          organizationId: context.organizationId,
          linkId,
          nodeId: frame.nodeId,
          ...frameColumns(frame, placement),
          snapshotStatus: placement.captured ? 'pending' : 'skipped',
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        })),
      );
    }
  }

  /**
   * "Refresh from Figma": new frames inserted; existing ones renamed, moved or resized in place
   * (same id, so their comment threads stay) and captured again when within the limit; frames
   * Figma no longer has marked gone (kept, with their threads). One transaction (the caller's).
   */
  async applyFrameDiff(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    diff: FrameDiff,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await this.insertFrames(runner, context, linkId, diff.inserts);
    for (const change of diff.updates) {
      await db
        .update(figmaFrames)
        .set({
          ...frameColumns(change.frame, change.placement),
          snapshotStatus: change.placement.captured ? 'pending' : 'skipped',
          snapshotAttempts: 0,
          claimedAt: null,
          goneAt: null,
          ...(change.sizeChanged ? { sizeChanged: true } : {}),
          updatedAt: sql`current_timestamp(3)`,
        })
        .where(
          and(
            eq(figmaFrames.organizationId, context.organizationId),
            eq(figmaFrames.id, change.row.id),
          ),
        );
    }
    if (diff.gone.length > 0) {
      await db
        .update(figmaFrames)
        .set({ goneAt: sql`current_timestamp(3)`, updatedAt: sql`current_timestamp(3)` })
        .where(
          and(
            eq(figmaFrames.organizationId, context.organizationId),
            eq(figmaFrames.linkId, linkId),
            inArray(
              figmaFrames.id,
              diff.gone.map((row) => row.id),
            ),
          ),
        );
    }
  }

  /**
   * The team chose pages: each frame's place in the capture order and whether it is captured. A
   * frame newly within the limit goes back to `pending`; one left out with no snapshot yet becomes
   * `skipped`; a stored snapshot is kept either way. Answers how many frames were queued.
   */
  async placeFrames(
    runner: TenantQueryRunner,
    context: TenantContext,
    rows: readonly FigmaFrameRow[],
    placements: ReadonlyMap<string, FramePlacement>,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    let queued = 0;
    for (const row of rows) {
      const placement = placements.get(row.nodeId);
      if (!placement) continue;
      const wakes = placement.captured && row.snapshotStatus === 'skipped';
      const status =
        row.snapshotStatus === 'ready' || row.snapshotStatus === 'failed'
          ? row.snapshotStatus
          : wakes
            ? 'pending'
            : placement.captured
              ? row.snapshotStatus
              : 'skipped';
      if (wakes) queued += 1;
      await db
        .update(figmaFrames)
        .set({
          captureRank: placement.captureRank,
          snapshotStatus: status,
          ...(wakes ? { snapshotAttempts: 0, claimedAt: null } : {}),
          updatedAt: sql`current_timestamp(3)`,
        })
        .where(
          and(eq(figmaFrames.organizationId, context.organizationId), eq(figmaFrames.id, row.id)),
        );
    }
    return queued;
  }

  /** The outline's pages, the file's name and the sync time, after a read from Figma. */
  async updateLinkOutline(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    input: { readonly fileName: string | null; readonly outlineJson: string },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(figmaLinks)
      .set({
        ...(input.fileName ? { fileName: input.fileName } : {}),
        outlineJson: input.outlineJson,
        syncedAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(and(eq(figmaLinks.organizationId, context.organizationId), eq(figmaLinks.id, linkId)));
  }

  /** The pages chosen for capture (a JSON list of page ids), or null for every page. */
  async setPageFilter(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    pageFilterJson: string | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(figmaLinks)
      .set({ pageFilterJson, updatedAt: sql`current_timestamp(3)` })
      .where(and(eq(figmaLinks.organizationId, context.organizationId), eq(figmaLinks.id, linkId)));
  }

  async findLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<FigmaLinkRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(figmaLinks)
      .where(
        and(
          eq(figmaLinks.organizationId, context.organizationId),
          eq(figmaLinks.id, linkId),
          isNull(figmaLinks.deletedAt),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** The live links attached to one object (a work item, deliverable version or request). */
  async listLinksAttachedTo(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    target: { readonly type: FigmaAttachTarget; readonly id: string } | null,
  ): Promise<readonly FigmaLinkRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(figmaLinks)
      .where(
        and(
          eq(figmaLinks.organizationId, context.organizationId),
          eq(figmaLinks.projectId, projectId),
          isNull(figmaLinks.deletedAt),
          ...(target
            ? [eq(figmaLinks.attachedToType, target.type), eq(figmaLinks.attachedToId, target.id)]
            : []),
        ),
      )
      .orderBy(asc(figmaLinks.createdAt))
      .limit(100);
  }

  /** The project of the work item, deliverable version, request or file a link is attached to. */
  async attachTargetProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    type: FigmaAttachTarget,
    id: string,
  ): Promise<string | null> {
    const db = tenantDrizzle(runner);
    if (type === 'file_asset') {
      const files = await db
        .select({ projectId: fileAssets.projectId })
        .from(fileAssets)
        .where(
          and(
            eq(fileAssets.organizationId, context.organizationId),
            eq(fileAssets.id, id),
            isNull(fileAssets.deletedAt),
          ),
        )
        .limit(1);
      return files[0]?.projectId ?? null;
    }
    const table =
      type === 'work_item'
        ? workItems
        : type === 'request'
          ? clientRequests
          : type === 'deliverable'
            ? deliverables
            : deliverableVersions;
    const rows = await db
      .select({ projectId: table.projectId })
      .from(table)
      .where(and(eq(table.organizationId, context.organizationId), eq(table.id, id)))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  async softDeleteLink(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
    purgeAfter: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(figmaLinks)
      .set({
        deletedAt: sql`current_timestamp(3)`,
        purgeAfter,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(figmaLinks.organizationId, context.organizationId),
          eq(figmaLinks.id, linkId),
          isNull(figmaLinks.deletedAt),
        ),
      );
    return affected(result) === 1;
  }

  // ── Frames ─────────────────────────────────────────────────────────────

  async listFrames(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkId: string,
  ): Promise<readonly FigmaFrameRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(figmaFrames)
      .where(
        and(eq(figmaFrames.organizationId, context.organizationId), eq(figmaFrames.linkId, linkId)),
      )
      .orderBy(asc(figmaFrames.sortOrder), asc(figmaFrames.id));
  }

  async findFrame(
    runner: TenantQueryRunner,
    context: TenantContext,
    frameId: string,
  ): Promise<FigmaFrameRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(figmaFrames)
      .where(
        and(eq(figmaFrames.organizationId, context.organizationId), eq(figmaFrames.id, frameId)),
      )
      .limit(1);
    return rows[0];
  }

  // ── Snapshot job ───────────────────────────────────────────────────────

  async organizationsWithPendingFrames(
    runner: BootstrapQueryRunner,
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: figmaFrames.organizationId })
      .from(figmaFrames)
      .where(
        and(
          eq(figmaFrames.snapshotStatus, 'pending'),
          isNull(figmaFrames.goneAt),
          unclaimedOrStale(staleBefore),
        ),
      )
      .orderBy(asc(figmaFrames.organizationId));
    return rows.map((row) => row.organizationId);
  }

  async listPendingFrames(
    runner: TenantQueryRunner,
    context: TenantContext,
    staleBefore: Date,
    limit: number,
  ): Promise<readonly FigmaFrameRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(figmaFrames)
      .where(
        and(
          eq(figmaFrames.organizationId, context.organizationId),
          eq(figmaFrames.snapshotStatus, 'pending'),
          isNull(figmaFrames.goneAt),
          unclaimedOrStale(staleBefore),
        ),
      )
      .orderBy(asc(figmaFrames.captureRank), asc(figmaFrames.linkId), asc(figmaFrames.sortOrder))
      .limit(limit);
  }

  /** The links named, live or not (a removed link's pending frames are dropped by the job). */
  async findLinks(
    runner: TenantQueryRunner,
    context: TenantContext,
    linkIds: readonly string[],
  ): Promise<readonly FigmaLinkRow[]> {
    if (linkIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(figmaLinks)
      .where(
        and(
          eq(figmaLinks.organizationId, context.organizationId),
          inArray(figmaLinks.id, [...new Set(linkIds)]),
        ),
      );
  }

  /** Conditional claim: pending, unclaimed or stale, at the attempt count the caller read. */
  async claimFrame(
    runner: TenantQueryRunner,
    context: TenantContext,
    frame: Pick<FigmaFrameRow, 'id' | 'snapshotAttempts'>,
    now: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(figmaFrames)
      .set({ claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(figmaFrames.organizationId, context.organizationId),
          eq(figmaFrames.id, frame.id),
          eq(figmaFrames.snapshotStatus, 'pending'),
          eq(figmaFrames.snapshotAttempts, frame.snapshotAttempts),
          unclaimedOrStale(staleBefore),
        ),
      );
    return affected(result) === 1;
  }

  async markSnapshotReady(
    runner: TenantQueryRunner,
    context: TenantContext,
    frameId: string,
    input: SnapshotReadyInput,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(figmaFrames)
      .set({
        snapshotStatus: 'ready',
        snapshotError: null,
        snapshotObjectKey: input.objectKey,
        snapshotHash: input.hash,
        width: input.width,
        height: input.height,
        hasThumb: input.hasThumb,
        capturedAt: now,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(figmaFrames.organizationId, context.organizationId),
          eq(figmaFrames.id, frameId),
          eq(figmaFrames.snapshotStatus, 'pending'),
        ),
      );
    return affected(result) === 1;
  }

  /** A failed try: one attempt counted, `failed` at the last one (or at once when `final`). */
  async recordSnapshotFailure(
    runner: TenantQueryRunner,
    context: TenantContext,
    frame: Pick<FigmaFrameRow, 'id' | 'snapshotAttempts'>,
    final: boolean,
    now: Date,
    reason: FigmaSnapshotError = 'unreachable',
  ): Promise<void> {
    const attempts = frame.snapshotAttempts + 1;
    const failed = final || attempts >= FIGMA_SNAPSHOT_MAX_ATTEMPTS;
    await tenantDrizzle(runner)
      .update(figmaFrames)
      .set({
        snapshotAttempts: Math.min(attempts, 255),
        snapshotError: reason,
        snapshotStatus: failed ? 'failed' : 'pending',
        claimedAt: failed ? null : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(figmaFrames.organizationId, context.organizationId),
          eq(figmaFrames.id, frame.id),
          eq(figmaFrames.snapshotStatus, 'pending'),
        ),
      );
  }

  /** Give a claim back without counting an attempt (rate limited: try on the next tick). */
  async releaseFrame(
    runner: TenantQueryRunner,
    context: TenantContext,
    frameId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(figmaFrames)
      .set({ claimedAt: null, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(figmaFrames.organizationId, context.organizationId),
          eq(figmaFrames.id, frameId),
          eq(figmaFrames.snapshotStatus, 'pending'),
        ),
      );
  }
}
