import { isInternalRole, uuidv7 } from '@tmanage/domain';
import type { AttemptResult, BreakerDecision } from '../../jobs/webhook-retry-sweeper.js';
import { insertNotification, listActiveOrgWideMemberships } from './notifications-store.js';
import type { WorkerDatabase, WorkerTransaction } from './worker-database.js';

/**
 * R13 slice 2 (54-03 + 56-08) — the worker's statements on `webhook_endpoints`,
 * `webhook_deliveries` and the one read of `outbox_events` delivery needs. Every statement names
 * `organization_id`. The delivery logic itself lives in `consumers/webhook-deliveries.ts`.
 */

/** The inbox notice type sent to owners / org admins when an endpoint is paused. */
export const WEBHOOK_PAUSED_NOTICE_TYPE = 'webhook.endpoint_paused';

export interface OpenAttempt {
  readonly id: string;
  readonly endpointId: string;
  readonly eventId: string | null;
  readonly eventKind: string | null;
  readonly status: string;
  readonly attempt: number;
  readonly attemptedAt: Date;
  readonly nextAttemptAt: Date;
}

export interface EndpointForDelivery {
  readonly id: string;
  readonly url: string;
  readonly status: string;
  readonly enabled: boolean;
  readonly secretHash: string;
  readonly secretEnc: string | null;
  readonly secretPrevEnc: string | null;
  readonly secretPrevExpiresAt: Date | null;
}

export interface EventForDelivery {
  readonly type: string;
  readonly payload: unknown;
  readonly occurredAt: Date;
}

export interface AttemptSettlement extends AttemptResult {
  readonly durationMs: number | null;
  readonly responseExcerpt: string | null;
  readonly signatureKeyId: string | null;
  readonly resolvedIp: string | null;
}

export interface WebhookDeliveryStore {
  /** Organizations with at least one active endpoint — the sweep walks `ix_wd_next` per org. */
  listActiveOrganizations(): Promise<readonly string[]>;
  /** Pending and in-flight attempts (`next_attempt_at IS NOT NULL`), oldest due first. */
  listOpenAttempts(organizationId: string, limit: number): Promise<readonly OpenAttempt[]>;
  /** Put a crashed `sending` row back to `pending`. */
  reopen(organizationId: string, id: string): Promise<void>;
  /** `pending` → `sending`; false when another process got there first. */
  claim(organizationId: string, id: string, now: Date): Promise<boolean>;
  loadEndpoint(organizationId: string, endpointId: string): Promise<EndpointForDelivery | null>;
  loadEvent(organizationId: string, eventId: string): Promise<EventForDelivery | null>;
  /**
   * Settle the attempt and apply the breaker in one transaction: write the outcome, bump or reset
   * the streak, then `decide(streakAfter)` and act on it (schedule the next attempt, or pause and
   * notify). Returns the decision taken.
   */
  finish(
    organizationId: string,
    attempt: OpenAttempt,
    settlement: AttemptSettlement,
    decide: (streakAfter: number) => BreakerDecision,
    now: Date,
  ): Promise<BreakerDecision>;
}

const SELECT_ACTIVE_ENDPOINTS =
  "SELECT id, events_json FROM webhook_endpoints WHERE organization_id = ? AND enabled = 1 AND status = 'active'";
const INSERT_PENDING =
  'INSERT INTO webhook_deliveries (id, organization_id, endpoint_id, event_id, event_kind, status, attempt, attempted_at, next_attempt_at) ' +
  "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)";

export async function stagePending(
  tx: WorkerTransaction,
  organizationId: string,
  input: { endpointId: string; eventId: string; eventKind: string; attempt: number; at: Date },
): Promise<void> {
  await tx.query(INSERT_PENDING, [
    uuidv7(),
    organizationId,
    input.endpointId,
    input.eventId,
    input.eventKind,
    input.attempt,
    input.at,
    input.at,
  ]);
}

/** The recipients of the paused notice: org-wide owners and org admins. */
export function isWebhookNoticeRecipient(candidate: {
  readonly role: string;
  readonly hasOrgWideScope: boolean;
}): boolean {
  return (
    isInternalRole(candidate.role) &&
    (candidate.role === 'owner' || candidate.role === 'org_admin') &&
    candidate.hasOrgWideScope
  );
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function createWebhookDeliveryStore(database: WorkerDatabase): WebhookDeliveryStore {
  return {
    listActiveOrganizations: () =>
      database.read(async (tx) => {
        const rows = await tx.query<readonly { organization_id: string }[]>(
          "SELECT DISTINCT organization_id FROM webhook_endpoints WHERE status = 'active' AND enabled = 1",
        );
        return rows.map((row) => row.organization_id);
      }),
    listOpenAttempts: (organizationId, limit) =>
      database.read(async (tx) => {
        const rows = await tx.query<
          readonly {
            id: string;
            endpoint_id: string;
            event_id: string | null;
            event_kind: string | null;
            status: string;
            attempt: number;
            attempted_at: Date;
            next_attempt_at: Date;
          }[]
        >(
          'SELECT id, endpoint_id, event_id, event_kind, status, attempt, attempted_at, next_attempt_at ' +
            'FROM webhook_deliveries WHERE organization_id = ? AND next_attempt_at IS NOT NULL ' +
            'ORDER BY next_attempt_at, id LIMIT ?',
          [organizationId, Math.max(1, Math.trunc(limit))],
        );
        return rows.map((row) => ({
          id: row.id,
          endpointId: row.endpoint_id,
          eventId: row.event_id,
          eventKind: row.event_kind,
          status: row.status,
          attempt: Number(row.attempt),
          attemptedAt: toDate(row.attempted_at),
          nextAttemptAt: toDate(row.next_attempt_at),
        }));
      }),
    reopen: (organizationId, id) =>
      database.transaction(async (tx) => {
        await tx.query(
          "UPDATE webhook_deliveries SET status = 'pending' WHERE organization_id = ? AND id = ? AND status = 'sending'",
          [organizationId, id],
        );
      }),
    claim: (organizationId, id, now) =>
      database.transaction(async (tx) => {
        const result = await tx.query<{ affectedRows: number }>(
          "UPDATE webhook_deliveries SET status = 'sending', attempted_at = ? " +
            "WHERE organization_id = ? AND id = ? AND status = 'pending'",
          [now, organizationId, id],
        );
        return result.affectedRows === 1;
      }),
    loadEndpoint: (organizationId, endpointId) =>
      database.read(async (tx) => {
        const rows = await tx.query<
          readonly {
            id: string;
            url: string;
            status: string;
            enabled: number;
            secret_hash: string;
            secret_enc: string | null;
            secret_prev_enc: string | null;
            secret_prev_expires_at: Date | null;
          }[]
        >(
          'SELECT id, url, status, enabled, secret_hash, secret_enc, secret_prev_enc, secret_prev_expires_at ' +
            'FROM webhook_endpoints WHERE organization_id = ? AND id = ? LIMIT 1',
          [organizationId, endpointId],
        );
        const row = rows[0];
        if (row === undefined) return null;
        return {
          id: row.id,
          url: row.url,
          status: row.status,
          enabled: Boolean(row.enabled),
          secretHash: row.secret_hash,
          secretEnc: row.secret_enc,
          secretPrevEnc: row.secret_prev_enc,
          secretPrevExpiresAt:
            row.secret_prev_expires_at === null ? null : toDate(row.secret_prev_expires_at),
        };
      }),
    loadEvent: (organizationId, eventId) =>
      database.read(async (tx) => {
        const rows = await tx.query<
          readonly { type: string; payload_json: unknown; occurred_at: Date }[]
        >(
          'SELECT type, payload_json, occurred_at FROM outbox_events WHERE organization_id = ? AND id = ? LIMIT 1',
          [organizationId, eventId],
        );
        const row = rows[0];
        if (row === undefined) return null;
        let payload: unknown = row.payload_json;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            payload = null;
          }
        }
        return { type: row.type, payload, occurredAt: toDate(row.occurred_at) };
      }),
    finish: (organizationId, attempt, settlement, decide, now) =>
      database.transaction(async (tx) => {
        await tx.query(
          'UPDATE webhook_deliveries SET status = ?, response_code = ?, response_excerpt = ?, duration_ms = ?, ' +
            'signature_key_id = ?, resolved_ip = ?, next_attempt_at = NULL WHERE organization_id = ? AND id = ?',
          [
            settlement.status,
            settlement.responseCode,
            settlement.responseExcerpt,
            settlement.durationMs,
            settlement.signatureKeyId,
            settlement.resolvedIp,
            organizationId,
            attempt.id,
          ],
        );
        let streakAfter = 0;
        if (settlement.status === 'success') {
          await tx.query(
            'UPDATE webhook_endpoints SET failure_streak = 0 WHERE organization_id = ? AND id = ?',
            [organizationId, attempt.endpointId],
          );
        } else if (settlement.status === 'failure' || settlement.status === 'blocked_private_ip') {
          await tx.query(
            'UPDATE webhook_endpoints SET failure_streak = failure_streak + 1 WHERE organization_id = ? AND id = ?',
            [organizationId, attempt.endpointId],
          );
          const rows = await tx.query<readonly { failure_streak: number }[]>(
            'SELECT failure_streak FROM webhook_endpoints WHERE organization_id = ? AND id = ? LIMIT 1',
            [organizationId, attempt.endpointId],
          );
          streakAfter = Number(rows[0]?.failure_streak ?? 0);
        }
        const decision = decide(streakAfter);
        if (decision.kind === 'retry' && attempt.eventId !== null && attempt.eventKind !== null) {
          await stagePending(tx, organizationId, {
            endpointId: attempt.endpointId,
            eventId: attempt.eventId,
            eventKind: attempt.eventKind,
            attempt: attempt.attempt + 1,
            at: new Date(now.getTime() + decision.delayMs),
          });
        }
        if (decision.kind === 'pause') {
          const paused = await tx.query<{ affectedRows: number }>(
            "UPDATE webhook_endpoints SET status = 'paused', paused_reason = ?, updated_at = ? " +
              "WHERE organization_id = ? AND id = ? AND status = 'active'",
            [decision.reason, now, organizationId, attempt.endpointId],
          );
          // Only the transition tells anyone: a second failure racing in finds it paused already.
          if (paused.affectedRows === 1) {
            const candidates = await listActiveOrgWideMemberships(tx, organizationId);
            for (const candidate of candidates.filter(isWebhookNoticeRecipient)) {
              await insertNotification(tx, {
                organizationId,
                recipientUserId: candidate.userId,
                type: WEBHOOK_PAUSED_NOTICE_TYPE,
                objectType: 'webhook_endpoint',
                objectId: attempt.endpointId,
                dedupeKey: `webhook.paused:${attempt.endpointId}:${String(now.getTime())}`,
              });
            }
          }
        }
        return decision;
      }),
  };
}

/** The organization's `active`, enabled endpoints with their raw event list (staging). */
export async function listStagingEndpoints(
  tx: WorkerTransaction,
  organizationId: string,
): Promise<readonly { id: string; events_json: unknown }[]> {
  const rows = await tx.query<readonly { id: string; events_json: unknown }[]>(
    SELECT_ACTIVE_ENDPOINTS,
    [organizationId],
  );
  return Array.isArray(rows) ? rows : [];
}
