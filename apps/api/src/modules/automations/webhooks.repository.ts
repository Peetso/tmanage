import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { outboxEvents, webhookEndpoints } from '../../common/database/schema.js';
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
  /** The legacy single kind (0066): the first of `events`. */
  readonly eventKind: string;
  readonly secretHash: string;
  /** The person who registered the endpoint — the controller passes `context.userId`. */
  readonly createdBy: string;
  // ---- 0281 · R13 slice 2 ----
  /**
   * The id the row is written under. Supplied by the controller when the secret is encrypted
   * before the insert (the envelope's AAD binds it to this id); generated here otherwise.
   */
  readonly id?: string;
  readonly description?: string | null;
  /** The subscribed kinds, already allowlisted. Defaults to `[eventKind]`. */
  readonly events?: readonly string[];
  /** FieldCipher envelope of the secret; null when keyless (the row is then `needs_rotation`). */
  readonly secretEnc?: string | null;
  readonly status?: 'active' | 'needs_rotation';
}

/** 0281: what a rotation writes — the new secret, and the old one kept for the overlap. */
export interface RotateSecretInput {
  readonly secretHash: string;
  readonly secretEnc: string;
  readonly secretPrevEnc: string | null;
  readonly secretPrevHash: string | null;
  readonly rotatedAt: Date;
  readonly prevExpiresAt: Date | null;
}

/** 0281: one outbox event a replay re-delivers. */
export interface ReplayableEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
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
    const id = input.id ?? uuidv7();

    await db.insert(webhookEndpoints).values({
      id,
      organizationId: context.organizationId,
      url: input.url,
      eventKind: input.eventKind,
      secretHash: input.secretHash,
      enabled: true,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
      description: input.description ?? null,
      eventsJson: JSON.stringify(input.events ?? [input.eventKind]),
      status: input.status ?? 'active',
      secretEnc: input.secretEnc ?? null,
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
  // ---- 0281 · R13 slice 2 (webhooks v2) ----

  /** Replace the subscribed kinds (and, when given, the description). Tenant-scoped. */
  async updateSettings(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    patch: { readonly events?: readonly string[]; readonly description?: string | null },
  ): Promise<WebhookEndpointRow | null> {
    const db = tenantDrizzle(runner);
    await db
      .update(webhookEndpoints)
      .set({
        ...(patch.events !== undefined ? { eventsJson: JSON.stringify(patch.events) } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(webhookEndpoints.organizationId, context.organizationId),
          eq(webhookEndpoints.id, id),
        ),
      );
    return this.findById(runner, context, id);
  }

  /**
   * Store a rotated secret. The endpoint becomes `active` again when it was waiting for a secret
   * (`needs_rotation`); a paused endpoint stays paused — rotating is not resuming.
   */
  async rotateSecret(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: RotateSecretInput,
  ): Promise<WebhookEndpointRow | null> {
    const db = tenantDrizzle(runner);
    await db
      .update(webhookEndpoints)
      .set({
        secretHash: input.secretHash,
        secretEnc: input.secretEnc,
        secretPrevEnc: input.secretPrevEnc,
        secretPrevHash: input.secretPrevHash,
        secretRotatedAt: input.rotatedAt,
        secretPrevExpiresAt: input.prevExpiresAt,
        status: sql`case when ${webhookEndpoints.status} = 'needs_rotation' then 'active' else ${webhookEndpoints.status} end`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(webhookEndpoints.organizationId, context.organizationId),
          eq(webhookEndpoints.id, id),
        ),
      );
    return this.findById(runner, context, id);
  }

  /** Pause (with a reason) or resume (clears the reason and the breaker's streak). */
  async setStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    status: 'active' | 'paused',
    pausedReason: string | null,
  ): Promise<WebhookEndpointRow | null> {
    const db = tenantDrizzle(runner);
    await db
      .update(webhookEndpoints)
      .set({
        status,
        pausedReason,
        ...(status === 'active' ? { failureStreak: 0 } : {}),
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(webhookEndpoints.organizationId, context.organizationId),
          eq(webhookEndpoints.id, id),
        ),
      );
    return this.findById(runner, context, id);
  }

  /**
   * The acting tenant's outbox events of `types` in `[from, to]`, oldest first, at most `limit`.
   * The replay reads `limit + 1` to tell "exactly the cap" from "over it".
   */
  async listReplayableEvents(
    runner: TenantQueryRunner,
    context: TenantContext,
    types: readonly string[],
    from: Date,
    to: Date,
    limit: number,
  ): Promise<readonly ReplayableEvent[]> {
    if (types.length === 0) return [];
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        id: outboxEvents.id,
        type: outboxEvents.type,
        payload: outboxEvents.payloadJson,
        occurredAt: outboxEvents.occurredAt,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.organizationId, context.organizationId),
          inArray(outboxEvents.type, [...types]),
          gte(outboxEvents.occurredAt, from),
          lte(outboxEvents.occurredAt, to),
        ),
      )
      .orderBy(asc(outboxEvents.occurredAt), asc(outboxEvents.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: typeof row.payload === 'string' ? safeParse(row.payload) : row.payload,
      occurredAt: row.occurredAt,
    }));
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
