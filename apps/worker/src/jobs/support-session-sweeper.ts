import type { WorkerDatabase } from '../common/database/worker-database.js';
import { createSupportSessionSweepStore } from '../common/database/support-session-sweep-store.js';

/**
 * platform-admin v2 · PA-05 (SPEC §3.2, §7 item 12): the Support-session expiry sweeper.
 *
 * A Support session is a hidden `platform_support` membership tied to a
 * `platform_support_sessions` row with an `expires_at`. PA-01's resolver already refuses the row
 * the moment the session expires, so nobody keeps access past it; this job tidies up behind it,
 * every minute in loop mode and once per `--sweep-support-sessions`:
 *
 * - the session row gets `ended_at` and `ended_reason = 'expired'`;
 * - the hidden row is set `offboarded` — or, when the visit upgraded the admin's own membership,
 *   that row gets its role, status and scope back;
 * - `organizations.policy_version` is bumped, so every cached context of that organization dies;
 * - the organization's audit log gets `support.session_ended` (owners see it) and the platform log
 *   `platform.support_session_ended`.
 *
 * One transaction per session; a session someone else ended first is skipped (idempotent).
 */

/** The most sessions one run ends; the next run takes the rest. */
export const SUPPORT_SWEEP_BATCH = 100;
/** Loop mode runs the sweep this often. */
export const SUPPORT_SWEEP_INTERVAL_MS = 60_000;

export interface ExpiredSupportSession {
  readonly id: string;
  readonly adminUserId: string;
  readonly organizationId: string;
  readonly membershipId: string | null;
  readonly previousRole: string | null;
  readonly previousHasOrgWideScope: boolean | null;
  readonly actionsCount: number;
}

/** What leaving the organization does to the admin's membership row. */
export type MembershipExit =
  | { readonly kind: 'none' }
  | { readonly kind: 'offboard'; readonly membershipId: string }
  | {
      readonly kind: 'restore';
      readonly membershipId: string;
      readonly role: string;
      readonly status: string;
      readonly hasOrgWideScope: boolean;
    };

/** The statements the sweep needs. Faked by the unit test. */
export interface SupportSessionSweepStore {
  /** Open sessions whose `expires_at` has passed (database clock), oldest first. */
  listExpired(limit: number): Promise<readonly ExpiredSupportSession[]>;
  /**
   * In ONE transaction: end the row (only if still open), apply the membership exit, bump the
   * organization's policy version and write both audit rows. False when it was already ended.
   */
  endExpired(session: ExpiredSupportSession, exit: MembershipExit): Promise<boolean>;
}

const KEPT_STATUSES = new Set(['invited', 'suspended', 'offboarded']);

/** The API's `planExit` (hidden-membership.ts), restated: the worker does not import the API. */
export function membershipExitFor(session: ExpiredSupportSession): MembershipExit {
  if (session.membershipId === null) return { kind: 'none' };
  if (session.previousRole === null) {
    return { kind: 'offboard', membershipId: session.membershipId };
  }
  const colon = session.previousRole.indexOf(':');
  const status = colon > 0 ? session.previousRole.slice(0, colon) : '';
  const kept = KEPT_STATUSES.has(status);
  return {
    kind: 'restore',
    membershipId: session.membershipId,
    role: kept ? session.previousRole.slice(colon + 1) : session.previousRole,
    status: kept ? status : 'active',
    hasOrgWideScope: session.previousHasOrgWideScope ?? false,
  };
}

export interface SupportSweepResult {
  readonly ended: number;
  readonly offboarded: number;
  readonly restored: number;
}

export async function sweepSupportSessions(
  store: SupportSessionSweepStore,
  limit = SUPPORT_SWEEP_BATCH,
): Promise<SupportSweepResult> {
  const expired = await store.listExpired(limit);
  let ended = 0;
  let offboarded = 0;
  let restored = 0;
  for (const session of expired) {
    const exit = membershipExitFor(session);
    if (!(await store.endExpired(session, exit))) continue;
    ended += 1;
    if (exit.kind === 'offboard') offboarded += 1;
    if (exit.kind === 'restore') restored += 1;
  }
  return { ended, offboarded, restored };
}

/** `--sweep-support-sessions`: one pass over the worker's pool. */
export function runSupportSessionSweep(database: WorkerDatabase): Promise<SupportSweepResult> {
  return sweepSupportSessions(createSupportSessionSweepStore(database));
}

/**
 * Loop mode: one pass now and one every {@link SUPPORT_SWEEP_INTERVAL_MS} until the signal aborts.
 * A failed pass is logged and the next one tries again; it never ends the process.
 */
export async function runSupportSessionSweepLoop(
  database: WorkerDatabase,
  signal: AbortSignal,
  onError: (error: unknown) => void = (error) => {
    console.error('[worker] support-session sweep failed', error);
  },
  intervalMs = SUPPORT_SWEEP_INTERVAL_MS,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const result = await runSupportSessionSweep(database);
      if (result.ended > 0) {
        console.warn(`[worker] support sessions: ended ${String(result.ended)} expired session(s)`);
      }
    } catch (error) {
      onError(error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
