/**
 * TEN-003 / ON-04: the scheduled half of invitation expiry.
 *
 * The API already carries the *manual* sweep — `POST /invitations/expirations`, backed by
 * `invitations.repository.ts` `expireOverdue` — but nothing runs it on its own, so an
 * invitation whose `expires_at` has passed stays `pending` in the table until a human calls the
 * route (23-ERD §9's `pending → expired`). This is the job that closes that gap: a worker
 * command a host cron invokes on the `relay:once` shape it already schedules.
 *
 * The state transition itself — and, critically, the DB-clock comparison it must use rather than
 * the app clock — lives in the store's SQL (`common/database/invitations-sweep-store.ts`), the
 * one place in the worker permitted to spell it. This module is the seam above it: it takes an
 * {@link InvitationSweepStore}, runs the sweep and returns the count, so the command's contract
 * is unit-testable against a fake without a database (acceptance §4). The manual route is left
 * in place as a fallback — this job is added beside it, not in its stead.
 */

/**
 * The one statement the sweep needs, bound to a database by
 * {@link ./common/database/invitations-sweep-store.createInvitationSweepStore} and faked by the
 * unit test. Cross-tenant by construction: like the relay's outbox claim, it carries no
 * organization selector — the process runs as the privileged `tmanage_worker` system role and
 * sweeps every tenant at once, exactly as the manual route does per tenant.
 */
export interface InvitationSweepStore {
  /**
   * Move every `pending` invitation whose `expires_at` is at or before the database clock to
   * `expired`, across every tenant, and return how many moved. Never touches `accepted` or
   * `revoked` rows.
   */
  expireOverdue(): Promise<number>;
}

export interface InvitationSweepResult {
  /** How many `pending` invitations this run moved to `expired` — 0 when nothing was overdue. */
  readonly expired: number;
}

/**
 * Run one sweep and report what it moved. Idempotent by construction: a second run with nothing
 * overdue moves nothing and reports 0, because the store's predicate selects only rows still
 * `pending`. Any store failure rejects, and `main` turns that into a non-zero exit.
 */
export async function sweepOverdueInvitations(
  store: InvitationSweepStore,
): Promise<InvitationSweepResult> {
  return { expired: await store.expireOverdue() };
}
