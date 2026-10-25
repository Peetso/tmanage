import { and, desc, eq, inArray } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightSnapshots, projects } from '../../common/database/schema.js';
import type { InsightSnapshotKind, InsightSnapshotRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x211's data seam — the tenant-scoped reads and the one write over `insight_snapshots`.
 *
 * A repository is the only layer allowed a driver handle (25-AUTH-AND-TENANT-ISOLATION §6); the
 * service takes a `TenantQueryRunner` from `TenantDatabase.transaction()` / `.read()` and hands it
 * here. Every statement filters or binds `organization_id` from the context — never from input — so a
 * snapshot can never be captured for, listed across, or fetched from another tenant. The reads carry
 * no policy: the org-level `work.read` gate lives in the controller, the posture INS-06's reads keep.
 */

/** The insert shape. `organizationId` is absent — it is taken from the context, never from input. */
export interface CreateInsightSnapshotInput {
  readonly id: string;
  readonly kind: InsightSnapshotKind;
  readonly capturedAt: Date;
  readonly payload: unknown;
}

export class InsightSnapshotsRepository {
  /**
   * Insert one snapshot. `captured_at` is the bound `Date` the service resolved (NOT the connection
   * clock — the admin-pool clock trap); `payload` is stored whole as the row's JSON.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateInsightSnapshotInput,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db.insert(insightSnapshots).values({
      id: input.id,
      organizationId: context.organizationId,
      kind: input.kind,
      capturedAt: input.capturedAt,
      payloadJson: input.payload,
      createdAt: input.capturedAt,
    });
  }

  /** List a tenant's snapshots of one kind, newest first, bounded to `limit`. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: InsightSnapshotKind,
    limit: number,
  ): Promise<readonly InsightSnapshotRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(insightSnapshots)
      .where(
        and(
          eq(insightSnapshots.organizationId, context.organizationId),
          eq(insightSnapshots.kind, kind),
        ),
      )
      .orderBy(desc(insightSnapshots.capturedAt), desc(insightSnapshots.id))
      .limit(limit);
  }

  /**
   * Fetch one snapshot by id, tenant-scoped on the composite `(organization_id, id)` key — a
   * cross-tenant id resolves to nothing, which the service maps to a 404.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<InsightSnapshotRow | undefined> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(insightSnapshots)
      .where(
        and(
          eq(insightSnapshots.organizationId, context.organizationId),
          eq(insightSnapshots.id, id),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * F21: the scope facts a reader's per-project `authorize` needs for the projects a stored payload
   * names — id, owning organization and archive state. Tenant-scoped on `organization_id`, so a
   * project id from another tenant (or one deleted since the capture) resolves to nothing and the
   * service drops it.
   */
  async projectScopes(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly SnapshotProjectScope[]> {
    if (projectIds.length === 0) return [];
    const db = tenantDrizzle(runner);
    return db
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        archivedAt: projects.archivedAt,
      })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, context.organizationId),
          inArray(projects.id, [...projectIds]),
        ),
      );
  }
}

/** F21: one project's scope facts, read so a snapshot payload can be filtered per reader. */
export interface SnapshotProjectScope {
  readonly id: string;
  readonly organizationId: string;
  readonly archivedAt: Date | null;
}
