import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { portalFeedback } from '../../common/database/schema.js';
import type { PortalFeedbackRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Portal deliverable feedback — x321's storage half (module 13, Client Portal).
 *
 * Follows `ClientProjectionsRepository`: `TenantContext` is the scoping parameter, no
 * `organizationId` on any input (it comes from the context), and every read and write is bound to
 * `(organization_id, …)` so a caller in the wrong tenant sees nothing rather than a leak. The
 * repository holds no policy — {@link PortalFeedbackService} decides who may write and read — and
 * the composite foreign key of migration 0189 is what makes a cross-tenant `deliverable_version_id`
 * a non-existent pair.
 *
 * One feedback per contact per version is stored by upsert on `(organization_id,
 * deliverable_version_id, client_contact_user_id)`: a contact revising their rating is an edit in
 * place, never a second row.
 */

export interface UpsertFeedbackInput {
  readonly deliverableVersionId: string;
  readonly clientContactUserId: string;
  /** Already bounded to 1–5 by the service before it reaches here. */
  readonly rating: number;
  /** Already trimmed by the service; `null` when the contact left a rating only. */
  readonly comment: string | null;
}

export class PortalFeedbackRepository {
  /** One contact's feedback for one version, scoped to the tenant; `null` if none. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
    clientContactUserId: string,
  ): Promise<PortalFeedbackRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(portalFeedback)
      .where(
        and(
          eq(portalFeedback.organizationId, context.organizationId),
          eq(portalFeedback.deliverableVersionId, deliverableVersionId),
          eq(portalFeedback.clientContactUserId, clientContactUserId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Set or revise one contact's feedback for a version. Idempotent by the
   * org+version+contact unique key: a re-submit updates `rating`, `comment` and `updated_at` in
   * place. `organization_id`, `deliverable_version_id` and `client_contact_user_id` are never
   * moved — the 0189 trigger holds them at the engine besides.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertFeedbackInput,
  ): Promise<PortalFeedbackRow> {
    const now = new Date();
    await tenantDrizzle(runner)
      .insert(portalFeedback)
      .values({
        id: uuidv7(),
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        deliverableVersionId: input.deliverableVersionId,
        clientContactUserId: input.clientContactUserId,
        rating: input.rating,
        comment: input.comment,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          rating: input.rating,
          comment: input.comment,
          updatedAt: now,
        },
      });

    // Read back so the persisted row and its server timestamps are what is returned, never a
    // hand-assembled guess. Tenant-scoped, so it cannot cross a tenant boundary.
    const saved = await this.find(
      runner,
      context,
      input.deliverableVersionId,
      input.clientContactUserId,
    );
    if (!saved) {
      // Unreachable: the upsert above committed this row in this transaction.
      throw new Error('portal feedback vanished immediately after upsert');
    }
    return saved;
  }

  /** Every feedback on one version, newest-first — the staff read. Tenant-scoped. */
  async listByVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    deliverableVersionId: string,
  ): Promise<readonly PortalFeedbackRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(portalFeedback)
      .where(
        and(
          eq(portalFeedback.organizationId, context.organizationId),
          eq(portalFeedback.deliverableVersionId, deliverableVersionId),
        ),
      )
      .orderBy(desc(portalFeedback.createdAt), desc(portalFeedback.id));
  }
}
