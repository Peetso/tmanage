import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { deliverableVersions } from '../../common/database/schema.js';
import type { DeliverableVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * FR-05's immutable content identity — the storage half of "an exact version and its hash".
 *
 * `ClientRequestsRepository`'s shape: `TenantContext` as the scoping parameter, no
 * `organizationId` on any input type, a scoped read that returns another tenant's row as absent
 * rather than throwing. What differs is that a version is *immutable* — there is deliberately no
 * `update`, so a governed content change is a new row (see the note in `0027`), and there is no
 * `delete`.
 */

export class DeliverableVersionNotFoundError extends Error {
  constructor(readonly deliverableVersionId: string) {
    // No organization id in the message, for the reason `ClientRequestNotFoundError` gives.
    super(`Deliverable version ${deliverableVersionId} was not found`);
    this.name = 'DeliverableVersionNotFoundError';
  }
}

/** What a caller supplies. `organizationId` comes from the context, never the input. */
export interface CreateDeliverableVersionInput {
  readonly projectId: string;
  readonly deliverableId: string;
  /** A validated lowercase hex SHA-256 digest (`content-hash.ts`). */
  readonly contentHash: string;
  readonly createdByUserId: string;
  /** 0211. The per-deliverable number, the attached file version and the team's note. */
  readonly versionNo?: number;
  readonly fileAssetId?: string | null;
  readonly fileVersionId?: string | null;
  readonly note?: string | null;
}

export class DeliverableVersionsRepository {
  /** Append a new immutable version. The tenant is the context's, not the input's. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDeliverableVersionInput,
  ): Promise<DeliverableVersionRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(deliverableVersions)
      .values({
        id,
        organizationId: context.organizationId,
        projectId: input.projectId,
        deliverableId: input.deliverableId,
        contentHash: input.contentHash,
        versionNo: input.versionNo ?? null,
        fileAssetId: input.fileAssetId ?? null,
        fileVersionId: input.fileVersionId ?? null,
        note: input.note ?? null,
        createdByUserId: input.createdByUserId,
        createdAt: new Date(),
      });
    return this.requireById(runner, context, id);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<DeliverableVersionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(deliverableVersions)
      .where(
        and(
          eq(deliverableVersions.organizationId, context.organizationId),
          eq(deliverableVersions.id, deliverableVersionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<DeliverableVersionRow> {
    const found = await this.findById(runner, context, deliverableVersionId);
    if (!found) throw new DeliverableVersionNotFoundError(deliverableVersionId);
    return found;
  }

  /** 0211. Every version of one deliverable, newest first — the detail screen's history. */
  async listForDeliverable(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
  ): Promise<readonly DeliverableVersionRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(deliverableVersions)
      .where(
        and(
          eq(deliverableVersions.organizationId, context.organizationId),
          eq(deliverableVersions.deliverableId, deliverableId),
        ),
      )
      .orderBy(desc(deliverableVersions.createdAt), desc(deliverableVersions.id));
  }

  /**
   * The deliverable's current governed version — the newest by creation.
   *
   * This is the row the decision transaction re-hashes against: FR-05's "changed governed
   * content creates new version" means the current version is the newest one, and an approval
   * whose captured hash no longer matches it is stale.
   */
  async latestForDeliverable(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableId: string,
  ): Promise<DeliverableVersionRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(deliverableVersions)
      .where(
        and(
          eq(deliverableVersions.organizationId, context.organizationId),
          eq(deliverableVersions.deliverableId, deliverableId),
        ),
      )
      .orderBy(desc(deliverableVersions.createdAt), desc(deliverableVersions.id))
      .limit(1);
    return rows[0] ?? null;
  }
}
