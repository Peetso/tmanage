/**
 * R13 slice 2 (54-03 + 56-08) — the outbound webhook retry sweep and breaker.
 *
 * The outbox consumer (`consumers/webhook-deliveries.ts`) stages one `pending` attempt per matching
 * endpoint inside the event's transaction; nothing is POSTed there. This loop is the only sender:
 * every {@link WEBHOOK_SWEEP_INTERVAL_MS} it runs one delivery pass, which takes the due attempts
 * (`next_attempt_at <= now`), at most one per endpoint at a time (per-endpoint concurrency 1), and
 * delivers them through the delivery-time egress guard.
 *
 * What happens after an attempt is decided here, as pure functions the unit suite enumerates:
 *
 * - **Backoff.** Attempt n fails → attempt n+1 after `WEBHOOK_RETRY_BACKOFF_MS[n-1]`: 1 m, 5 m,
 *   30 m, 2 h, 8 h. Five retries; after the fifth retry fails the event is given up on that
 *   endpoint (the row stays, `next_attempt_at` NULL, visible in the delivery log).
 * - **Breaker.** Every failed attempt adds one to the endpoint's `failure_streak`; a success resets
 *   it. At {@link WEBHOOK_BREAKER_THRESHOLD} consecutive failures — or at once on HTTP 410 Gone —
 *   the endpoint is paused and its organization's owners / org admins get an inbox notice (the
 *   existing `notifications` path). A paused endpoint's staged attempts are cancelled when reached.
 * - **Permanent failures** (event gone, secret unreadable) neither retry nor count to the breaker:
 *   they are not the receiver's fault.
 *
 * This file holds no SQL and no I/O beyond the timer; the pass it runs is injected (`main.ts`).
 */

export const WEBHOOK_RETRY_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  8 * 60 * 60_000,
] as const;
export const WEBHOOK_BREAKER_THRESHOLD = 20;
export const WEBHOOK_SWEEP_INTERVAL_MS = 10_000;

/** What one attempt came to, as the delivery records it. */
export type WebhookAttemptStatus =
  | 'success'
  | 'failure'
  | 'blocked_private_ip'
  /** Not the receiver's fault and not worth a retry: event gone, secret unreadable. */
  | 'failed_permanent'
  /** The endpoint was paused / disabled / lost its secret before the attempt ran. */
  | 'cancelled';

export interface AttemptResult {
  readonly status: WebhookAttemptStatus;
  readonly responseCode: number | null;
}

/** The delay before the attempt after `attempt` (1-based), or `null` when none is left. */
export function nextAttemptDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  return WEBHOOK_RETRY_BACKOFF_MS[attempt - 1] ?? null;
}

/** Whether the attempt counts against the endpoint (retry + breaker) or settles it. */
export function countsAsFailure(result: AttemptResult): boolean {
  return result.status === 'failure' || result.status === 'blocked_private_ip';
}

export type BreakerDecision =
  | { readonly kind: 'reset' }
  | { readonly kind: 'none' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'give_up' }
  | { readonly kind: 'pause'; readonly reason: 'gone_410' | 'breaker_20_failures' };

/**
 * After an attempt: reset the streak on success; pause on 410 or when the streak (already including
 * this failure) reaches the threshold; otherwise retry while the backoff table lasts.
 */
export function decideAfterAttempt(
  result: AttemptResult,
  attempt: number,
  streakAfter: number,
): BreakerDecision {
  if (result.status === 'success') return { kind: 'reset' };
  if (!countsAsFailure(result)) return { kind: 'none' };
  if (result.responseCode === 410) return { kind: 'pause', reason: 'gone_410' };
  if (streakAfter >= WEBHOOK_BREAKER_THRESHOLD)
    return { kind: 'pause', reason: 'breaker_20_failures' };
  const delayMs = nextAttemptDelayMs(attempt);
  return delayMs === null ? { kind: 'give_up' } : { kind: 'retry', delayMs };
}

export interface WebhookPassReport {
  readonly delivered: number;
  readonly failed: number;
}

/** Loop mode: one pass now and one every {@link WEBHOOK_SWEEP_INTERVAL_MS}; stops on `signal`. */
export async function runWebhookRetrySweepLoop(
  pass: () => Promise<WebhookPassReport>,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) =>
    console.error('[worker] webhook delivery pass failed', error),
  intervalMs = WEBHOOK_SWEEP_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const report = await pass();
      if (report.failed > 0) {
        console.warn(
          `[worker] webhooks: ${String(report.delivered)} delivered, ${String(report.failed)} failed`,
        );
      }
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
}
