import { sql } from 'drizzle-orm';
import { outboxAggregateTypeFor, uuidv7 } from '@tmanage/domain';
import type { OutboxEventPayloads, OutboxEventType } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { outboxEvents } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The outbox writer — PLAT-004's first half, `24-EVENT-CATALOG` §2's producer rule:
 * "Producer writes state and outbox event atomically."
 *
 * Same shape as `AuditEventsRepository.append`, and for the same reasons: it takes the
 * caller's `TenantQueryRunner` and cannot open a transaction of its own, so an event can
 * only ever commit with the state change it describes — spec §3 step 8. A rolled-back
 * command leaves no event claiming something happened, which is the property the pattern
 * exists for; the relay in `apps/worker` then delivers what *did* commit, at-least-once.
 *
 * ## What a caller may not choose
 *
 * The organization and correlation id come from the context; the aggregate type comes from
 * the event type via `outboxAggregateTypeFor`, exactly as an audit row's object type comes
 * from its action. The payload's *shape* is fixed by `OutboxEventPayloads`, so pairing
 * `message.created.v1` with a converted-message payload is a compile error rather than a
 * consumer's 3am surprise.
 *
 * ## What is deliberately absent
 *
 * There is no read method, no update, no delete. Claiming, publishing, retrying and
 * parking are the dispatcher's verbs, they run unscoped across every organization, and the
 * API process has no business doing any of them — `scripts/db/users.sql` gives the relay
 * its own narrower credential for exactly that work.
 */

export interface AppendOutboxEventInput<T extends OutboxEventType> {
  readonly type: T;
  /** The row the event is about. The aggregate *type* is derived from the event type. */
  readonly aggregateId: string;
  /** Ids and states only — a reference envelope, never a content copy (schema comment, §5). */
  readonly payload: OutboxEventPayloads[T];
}

export class OutboxEventsRepository {
  /**
   * Append one event inside the caller's unit of work.
   *
   * `occurred_at` and `available_at` are both the server's clock, not this process's — an
   * event stamped by a skewed application clock could be born minutes "in the future" and
   * sit undelivered while looking dispatchable. `available_at = occurred_at` means
   * deliverable immediately; only the dispatcher's retry backoff ever moves it later.
   */
  async append<T extends OutboxEventType>(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendOutboxEventInput<T>,
  ): Promise<string> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(outboxEvents)
      .values({
        id,
        // From the context, never from input — there is no such field.
        organizationId: context.organizationId,
        type: input.type,
        schemaVersion: 1,
        aggregateType: outboxAggregateTypeFor(input.type),
        aggregateId: input.aggregateId,
        payloadJson: input.payload,
        // The request that caused the state change is the request that caused the event.
        correlationId: context.correlationId,
        occurredAt: sql`current_timestamp(3)`,
        availableAt: sql`current_timestamp(3)`,
      });

    return id;
  }
}
