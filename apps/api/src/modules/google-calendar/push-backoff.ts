/**
 * LOGQUIET-c — per-connection back-off for the push channel renewal.
 *
 * The sync job runs every minute, and a provider that refuses the channel (Microsoft's calendar
 * unavailable, a revoked subscription) used to be asked again, and logged, every minute. After a
 * failure the next attempt waits {@link PUSH_BACKOFF_FIRST_MS}, doubled after each further failure
 * up to {@link PUSH_BACKOFF_CAP_MS}; a success forgets the connection. Only a failure that moves
 * to a longer wait is worth a log line, so a connection stuck at the cap goes quiet. The state is
 * in memory: a restart tries every connection once more, which is the point of a restart.
 */
export const PUSH_BACKOFF_FIRST_MS = 2 * 60_000;
export const PUSH_BACKOFF_CAP_MS = 6 * 60 * 60_000;

interface BackoffState {
  readonly waitMs: number;
  readonly nextAt: number;
}

export class PushBackoff {
  private readonly states = new Map<string, BackoffState>();

  /** Whether the connection may try now (never failed, or its wait is over). */
  mayTry(connectionId: string, nowMs: number): boolean {
    const state = this.states.get(connectionId);
    return state === undefined || nowMs >= state.nextAt;
  }

  /** Records a failure; returns the new wait when it grew (log it), `null` when it stays at the cap. */
  failed(connectionId: string, nowMs: number): number | null {
    const previous = this.states.get(connectionId);
    const waitMs =
      previous === undefined
        ? PUSH_BACKOFF_FIRST_MS
        : Math.min(previous.waitMs * 2, PUSH_BACKOFF_CAP_MS);
    this.states.set(connectionId, { waitMs, nextAt: nowMs + waitMs });
    return previous !== undefined && previous.waitMs === waitMs ? null : waitMs;
  }

  succeeded(connectionId: string): void {
    this.states.delete(connectionId);
  }
}
