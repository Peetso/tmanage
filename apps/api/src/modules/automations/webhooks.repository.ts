import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { webhookEndpoints } from '../../common/database/schema.js';
import type { WebhookEndpointRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The webhook-endpoints repository — Automations module 17 (x166), following the
 * `work_forms`/`decisions` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateWebhookEndpointInput} has
 *    no `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, so a forgotten predicate throws rather than
 *    leaking or touching another tenant's rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/**
 * Note what is absent: `organizationId`. It is taken from the context. `secretHash` is the SHA-256
 * digest the controller computed; the plaintext secret never reaches this layer.
 */
export interface CreateWebhookEndpointInput {
  readonly url: string;
  readonly eventKind: string;
  readonly secretHash: string;
  /** The person who registered the endpoint — the controller passes `context.userId`. */
  readonly createdBy: string;
}

export class WebhooksRepository {
  /**
   * List one tenant's endpoints, newest first. The `organization_id` predicate is present; `id`
   * (UUIDv7, ≈ creation order) is the deterministic tiebreaker.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly WebhookEndpointRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.organizationId, context.organizationId))
      .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id));
  }

  /**
   * Fetch one endpoint by id, within the acting tenant. No `findById(id)` without a context: on
   * MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<WebhookEndpointRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, context.organizationId),
          eq(webhookEndpoints.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Register an endpoint. The id is generated here (UUIDv7); `organization_id` comes from the
   * context, never from `input`. `enabled` defaults to true at the column.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWebhookEndpointInput,
  ): Promise<WebhookEndpointRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(webhookEndpoints).values({
      id,
      organizationId: context.organizationId,
      url: input.url,
      eventKind: input.eventKind,
      secretHash: input.secretHash,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed within this unit of work.
      throw new Error('webhook endpoint vanished immediately after insert');
    }
    return created;
  }

  /**
   * Toggle an endpoint's `enabled` flag within the acting tenant, and read it back. The predicate
   * carries both `organization_id` and `id`, so a cross-tenant id updates nothing; the 0066 trigger
   * refuses every column but `enabled` at the engine.
   */
  async setEnabled(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    enabled: boolean,
  ): Promise<WebhookEndpointRow | null> {
    const db = tenantDrizzle(runner);
    await db
      .update(webhookEndpoints)
      .set({ enabled })
      .where(
        and(
          eq(webhookEndpoints.organizationId, context.organizationId),
          eq(webhookEndpoints.id, id),
        ),
      );
    return this.findById(runner, context, id);
  }
}
