import {
  ACTIVITY_GAP_SECONDS,
  IDLE_THRESHOLD_MAX_MINUTES,
  IDLE_THRESHOLD_MIN_MINUTES,
  clampIdleSeconds,
  isAutoTrackingPolicy,
} from '@tmanage/domain';
import type { AutoTrackingPolicy } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { MAX_SPAN_MS } from './time-rules.js';

/**
 * FIX-2026-11-10 — the server half of automatic tracking: how heartbeats become sessions, and
 * what a finished session may be filed as. Pure, so the service and the unit test share one
 * reading of every rule.
 *
 * Nothing the client sends is a time. A heartbeat carries `idleSeconds` only; `now` is this
 * server's clock. So:
 *
 * - **Never in the future.** The last moment of activity is `now - idleSeconds`, never later.
 * - **Never longer than the evidence.** Two heartbeats join into one session only when they are at
 *   most {@link ACTIVITY_GAP_SECONDS} apart AND the input-free stretch between them is inside the
 *   person's idle threshold. A silent client (sleep, a closed lid, a made-up gap) ends the session
 *   at its last moment of activity. A session also ends at 24 hours.
 * - **Idle never counts.** The session ends at the last real input, not when idleness was noticed.
 * - **No overlap.** A new session never starts before the previous one ended, and a finished
 *   session is filed only on the stretches no other timed entry (a manual entry, a stopped or a
 *   running timer) of the same person already covers.
 * - **Two devices or tabs count once.** They feed the same row: each heartbeat can only move the
 *   last moment of activity forward, so overlapping devices extend one session.
 */

export interface OpenSession {
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly lastHeartbeatAt: Date;
}

export interface Span {
  readonly startedAt: Date;
  readonly endedAt: Date;
}

export interface HeartbeatOutcome {
  /** The session that ended with this heartbeat, to be filed; or null. */
  readonly closed: Span | null;
  /** The session open after this heartbeat; or null (idle, or nothing to open). */
  readonly open: OpenSession | null;
}

const ms = (seconds: number): number => seconds * 1000;

/** May a heartbeat at `now` still extend `session`? */
export function isLive(session: OpenSession, now: Date): boolean {
  return (
    now.getTime() - session.lastHeartbeatAt.getTime() <= ms(ACTIVITY_GAP_SECONDS) &&
    now.getTime() - session.startedAt.getTime() < MAX_SPAN_MS
  );
}

/**
 * One heartbeat. `idleSecondsRaw` is the client's "seconds since the last input"; `threshold` is
 * the person's idle threshold in seconds. A session that cannot be extended is closed at its last
 * activity; a new one opens only on a non-idle heartbeat, never before the closed one's end.
 */
export function applyHeartbeat(
  session: OpenSession | null,
  now: Date,
  idleSecondsRaw: number,
  thresholdSeconds: number,
): HeartbeatOutcome {
  const idleSeconds = clampIdleSeconds(idleSecondsRaw);
  const activeAt = new Date(now.getTime() - ms(idleSeconds));
  const idle = idleSeconds >= thresholdSeconds;

  if (session !== null) {
    const joins =
      isLive(session, now) &&
      activeAt.getTime() - session.lastActiveAt.getTime() <= ms(thresholdSeconds);
    if (joins) {
      const lastActiveAt =
        activeAt.getTime() > session.lastActiveAt.getTime() ? activeAt : session.lastActiveAt;
      return {
        closed: null,
        open: { startedAt: session.startedAt, lastActiveAt, lastHeartbeatAt: now },
      };
    }
  }

  const closed =
    session === null ? null : { startedAt: session.startedAt, endedAt: session.lastActiveAt };
  if (idle) return { closed, open: null };
  // A new session starts at the reported moment of activity, never before the previous end.
  const startedAt =
    closed !== null && activeAt.getTime() < closed.endedAt.getTime() ? closed.endedAt : activeAt;
  return { closed, open: { startedAt, lastActiveAt: startedAt, lastHeartbeatAt: now } };
}

/** The session a reader settles: ended at its last activity once no heartbeat can extend it. */
export function settle(session: OpenSession | null, now: Date): Span | null {
  if (session === null || isLive(session, now)) return null;
  return { startedAt: session.startedAt, endedAt: session.lastActiveAt };
}

/**
 * The stretches of `span` that no `busy` span covers, in order. A busy span with no end (a
 * running timer) covers everything after its start.
 */
export function freeSpans(
  span: Span,
  busy: readonly { readonly startedAt: Date; readonly endedAt: Date | null }[],
): readonly Span[] {
  let pieces: Span[] = [span];
  for (const block of busy) {
    const from = block.startedAt.getTime();
    const to = block.endedAt === null ? Number.POSITIVE_INFINITY : block.endedAt.getTime();
    const next: Span[] = [];
    for (const piece of pieces) {
      const start = piece.startedAt.getTime();
      const end = piece.endedAt.getTime();
      if (to <= start || from >= end) {
        next.push(piece);
        continue;
      }
      if (from > start) next.push({ startedAt: piece.startedAt, endedAt: new Date(from) });
      if (to < end) next.push({ startedAt: new Date(to), endedAt: piece.endedAt });
    }
    pieces = next;
  }
  return pieces;
}

/** Whole minutes an automatic entry records: rounded to the nearest minute, never rounded up. */
export function automaticMinutes(span: Span): number {
  return Math.round(Math.max(0, span.endedAt.getTime() - span.startedAt.getTime()) / 60_000);
}

// ---- input ----

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

/** `idleSeconds`: a whole number of seconds, 0 or more (larger values read as one day). */
export function parseIdleSeconds(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw invalid('idleSeconds', 'must be a whole number of seconds, 0 or more');
  }
  return clampIdleSeconds(raw);
}

/** `idleThresholdMinutes`: a whole number of minutes inside the allowed range. */
export function parseIdleThresholdMinutes(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < IDLE_THRESHOLD_MIN_MINUTES ||
    raw > IDLE_THRESHOLD_MAX_MINUTES
  ) {
    throw invalid(
      'idleThresholdMinutes',
      `must be a whole number from ${IDLE_THRESHOLD_MIN_MINUTES} to ${IDLE_THRESHOLD_MAX_MINUTES}`,
    );
  }
  return raw;
}

export function parsePolicy(raw: unknown): AutoTrackingPolicy {
  if (!isAutoTrackingPolicy(raw)) throw invalid('policy', 'must be off, optional or required');
  return raw;
}

/** Is automatic tracking on for this person, given the owner's policy and their own switch? */
export function effectiveEnabled(policy: AutoTrackingPolicy, ownSwitch: boolean): boolean {
  return policy === 'required' || (policy === 'optional' && ownSwitch);
}
