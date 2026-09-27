import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { InsightAnnotationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightSnapshotsRepository } from './snapshots.repository.js';
import { InsightAnnotationsRepository } from './insight-annotations.repository.js';

/**
 * x271's service — insight annotations (module 15, Insights & reporting). A member attaches an
 * explanatory note to an insight snapshot so a frozen figure carries context (INS-01 "every score is
 * explainable"), lists a snapshot's notes newest-first, and removes one they authored. A per-snapshot
 * surface kept in its own table `insight_annotations` and its own module, so it touches no file the
 * x211 snapshots slice owns (it soft-reads the snapshot, never edits it).
 *
 * ## The snapshot is resolved before the relation authorize
 *
 * Every operation names a snapshot in its path. The service resolves it tenant-scoped FIRST — a
 * cross-tenant or unknown `snapshotId` is a **404** with no write and no read (the soft read of x211
 * degrades to 404 on an unknown snapshot) — and only then applies the org-level relation authorize, so
 * existence is never leaked to a principal the capability refuses. `work.read` is the capability
 * (re-checked org-level here, the belt-and-braces the sibling insights reads apply): it is the
 * internal-read capability every internal role holds and no client role does, and the pass forbids
 * inventing one.
 *
 * ## Author-owned, and delete resolves ownership before it acts
 *
 * The author of a note is always the acting `principal`'s membership (`context.membershipId`) — the
 * request has no way to name another. {@link remove} resolves the annotation `(tenant, snapshot, id)`
 * first (an unknown one is a **404**), then refuses to delete a note authored by another member with a
 * **403** — the mandated refusal — so one member can never remove another's note.
 */

/**
 * What a caller sees of one annotation — paired Exact with the web's `InsightAnnotationView`.
 * `organizationId`/`snapshotId` are deliberately absent: the wire projection never echoes the tenant
 * id (`25-AUTH` §7) and the snapshot is the one named in the path. `authorMembershipId` is surfaced so
 * the screen can mark the caller's own notes (and thus which carry a delete affordance).
 */
export interface InsightAnnotationView {
  readonly id: string;
  readonly authorMembershipId: string;
  readonly note: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

export class InsightAnnotationsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly annotations: InsightAnnotationsRepository = new InsightAnnotationsRepository(),
    private readonly snapshots: InsightSnapshotsRepository = new InsightSnapshotsRepository(),
  ) {}

  /**
   * Whether this principal may read/annotate the org's insights, judged by `work.read` against the
   * organization itself (`projectId: null`, internal audience) — the org-level relation half of the
   * capability the controller gated on the role. A client is refused (internal-only capability), and a
   * cross-tenant principal by the tenant check inside `authorize`.
   */
  private mayAnnotateOrgInsights(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /** Refuse with a 403 unless the principal may read/annotate the org's insights. */
  private requireOrgInsights(principal: Principal, context: TenantContext): void {
    if (!this.mayAnnotateOrgInsights(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'insight_annotation_denied',
      );
    }
  }

  /** Resolve a snapshot tenant-scoped or throw a 404 — the soft read of x211's `insight_snapshots`. */
  private async requireSnapshot(context: TenantContext, snapshotId: string): Promise<void> {
    const snapshot = await this.database.read(context, (runner) =>
      this.snapshots.findById(runner, context, snapshotId),
    );
    if (!snapshot) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'snapshot_not_found');
    }
  }

  /**
   * Attach a note to a snapshot, authored by the caller. Resolves the snapshot (404 if unknown) before
   * the relation authorize (403 if denied), then inserts with a bound `created_at` and the caller's
   * own membership. The note is already validated by the controller.
   */
  async add(
    context: TenantContext,
    principal: Principal,
    snapshotId: string,
    note: string,
  ): Promise<InsightAnnotationView> {
    await this.requireSnapshot(context, snapshotId);
    this.requireOrgInsights(principal, context);
    const row = await this.database.transaction(context, (tx) =>
      this.annotations.insert(tx, context, {
        snapshotId,
        authorMembershipId: context.membershipId,
        note,
        createdAt: new Date(),
      }),
    );
    return viewOf(row);
  }

  /** List a snapshot's annotations, newest first. Resolves the snapshot (404) before the authorize. */
  async list(
    context: TenantContext,
    principal: Principal,
    snapshotId: string,
  ): Promise<readonly InsightAnnotationView[]> {
    await this.requireSnapshot(context, snapshotId);
    this.requireOrgInsights(principal, context);
    const rows = await this.database.read(context, (runner) =>
      this.annotations.listForSnapshot(runner, context, snapshotId),
    );
    return rows.map(viewOf);
  }

  /**
   * Delete an annotation the caller authored. Resolves the snapshot (404 if unknown) and the
   * annotation `(tenant, snapshot, id)` (404 if unknown), then refuses a note authored by another
   * member with a 403 — the mandated refusal — before deleting.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    snapshotId: string,
    id: string,
  ): Promise<void> {
    await this.requireSnapshot(context, snapshotId);
    this.requireOrgInsights(principal, context);
    await this.database.transaction(context, async (tx) => {
      const existing = await this.annotations.findById(tx, context, snapshotId, id);
      if (!existing) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'insight_annotation_not_found',
        );
      }
      if (existing.authorMembershipId !== context.membershipId) {
        throw new ApiError(
          403,
          'forbidden',
          MESSAGES.forbidden,
          undefined,
          'insight_annotation_not_author',
        );
      }
      await this.annotations.deleteOwn(tx, context, snapshotId, id, context.membershipId);
    });
  }
}

function viewOf(row: InsightAnnotationRow): InsightAnnotationView {
  return {
    id: row.id,
    authorMembershipId: row.authorMembershipId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}
