import { and, desc, eq, lt } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { webhookDeliveries, webhookEndpoints } from '../../common/database/schema.js';
import type { WebhookDeliveryRow, WebhookEndpointRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The webhook-deliveries repository — Automations module 17 (x221), following the sibling
 * `webhooks.repository.ts` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link RecordDeliveryInput} has no
 *    `organizationId` field, so a caller cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, so a forgotten predicate throws rather than
 *    leaking or touching another tenant's rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** A keyset page. `before` is the exclusive-upper cursor (a delivery id); reads run newest first. */
export interface ListDeliveriesOptions {
  readonly before?: string;
  readonly limit: number;
}

/**
 * What the internal dispatch path records for one attempt. Note what is absent: `organizationId`
 * (taken from the context) and any secret or body field — a delivery row carries the outcome, never
 * the content, so the secret cannot leak through this layer.
 */
export interface RecordDeliveryInput {
  readonly endpointId: string;
  readonly status: string;
  /** The HTTP status code the target answered with, or null when no response was received. */
  readonly responseCode: number | null;
}

export class WebhookDeliveriesRepository {
  /**
   * Resolve one endpoint within the acting tenant. No `findEndpoint(id)` without a context: on MySQL
   * that would return another customer's row. Used to resolve `:endpointId` before authorize (404).
   */
  async findEndpoint(
    runner: TenantQueryRunner,
    context: TenantContext,
    endpointId: string,
  ): Promise<WebhookEndpointRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, context.organizationId),
          eq(webhookEndpoints.id, endpointId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List one endpoint's delivery attempts within the acting tenant, newest first, keyset-paged. The
   * `organization_id` and `endpoint_id` predicates are always present; `id` (UUIDv7, ≈ attempt order)
   * is the deterministic order and the cursor. `before` scans strictly older attempts.
   */
  async listByEndpoint(
    runner: TenantQueryRunner,
    context: TenantContext,
    endpointId: string,
    options: ListDeliveriesOptions,
  ): Promise<readonly WebhookDeliveryRow[]> {
    const db = tenantDrizzle(runner);
    const predicates = [
      eq(webhookDeliveries.organizationId, context.organizationId),
      eq(webhookDeliveries.endpointId, endpointId),
    ];
    if (options.before !== undefined) {
      predicates.push(lt(webhookDeliveries.id, options.before));
    }
    return db
      .select()
      .from(webhookDeliveries)
      .where(and(...predicates))
      .orderBy(desc(webhookDeliveries.id))
      .limit(options.limit);
  }

  /**
   * Record one delivery attempt. The id is generated here (UUIDv7); `organization_id` comes from the
   * context, never from `input`; `attempted_at` is the server clock. Append-only — the table grants
   * INSERT only, so there is no update path.
   */
  async record(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: RecordDeliveryInput,
  ): Promise<string> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(webhookDeliveries).values({
      id,
      organizationId: context.organizationId,
      endpointId: input.endpointId,
      status: input.status,
      responseCode: input.responseCode,
      attemptedAt: new Date(),
    });
    return id;
  }
}
