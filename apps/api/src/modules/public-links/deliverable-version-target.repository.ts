import { and, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { deliverables, deliverableVersions } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { PublicLinkTargetAdapter, ResolvedTarget } from './public-link-targets.js';

/**
 * 56-07 — the approver link's target (52-18 builds its screens and the deliverable-state side
 * effect): one deliverable version. The link binds the version's `content_hash`; the outsider
 * sees the deliverable's title and the version number, nothing else (no project, no note, no
 * other versions). No `onDecision` yet: the decision is recorded on the link only.
 */
export const deliverableVersionTarget: PublicLinkTargetAdapter = {
  targetType: 'deliverable_version',
  kinds: ['approval'],
  manageCapability: 'deliverable.publish',
  decisions: ['approve', 'request_changes'],
  async resolve(
    runner: TenantQueryRunner,
    context: TenantContext,
    targetId: string,
  ): Promise<ResolvedTarget | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        projectId: deliverableVersions.projectId,
        versionNo: deliverableVersions.versionNo,
        contentHash: deliverableVersions.contentHash,
        title: deliverables.title,
      })
      .from(deliverableVersions)
      .innerJoin(
        deliverables,
        and(
          eq(deliverables.organizationId, deliverableVersions.organizationId),
          eq(deliverables.id, deliverableVersions.deliverableId),
        ),
      )
      .where(
        and(
          eq(deliverableVersions.organizationId, context.organizationId),
          eq(deliverableVersions.id, targetId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      projectId: row.projectId,
      versionHash: row.contentHash,
      projection: { title: row.title, versionNo: row.versionNo },
    };
  },
};
