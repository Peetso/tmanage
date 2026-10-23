/**
 * A7 (0220): the scheduled half of "Defer until".
 *
 * The triage screen parks a client request in `deferred` with a date (`client_requests.defer_until`)
 * and, when "Reopen it on this date and remind me" was ticked, `reopen_reminder = 1` and the
 * deferrer's user id. "Reopen now" is the manual half (`POST :id/reopen`). This job is the date
 * arriving: every `deferred` request whose `defer_until` is at or before the database clock goes
 * back to `triage` with its schedule cleared, and a request whose deferrer asked to be reminded
 * leaves them an in-app notice.
 *
 * Cross-tenant by construction, like the invitation sweep: the process runs as `tmanage_worker`,
 * which already holds SELECT + UPDATE on `client_requests` and INSERT on `notifications`. The SQL
 * lives in `common/database/request-defer-store.ts`; this module is the seam above it, so the
 * job's contract is unit-testable against a fake store.
 */

/** One request the sweep is reopening, as the store reads it under lock. */
export interface DueDeferredRequest {
  readonly id: string;
  readonly organizationId: string;
  readonly version: number;
  /** The deferrer, when they asked to be reminded; `null` means reopen silently. */
  readonly remindUserId: string | null;
}

/** The statements the sweep needs, in one transaction. Faked by the unit test. */
export interface RequestDeferSweepStore {
  /**
   * Lock and return every `deferred` request due now (database clock), reopen each to `triage`
   * clearing `defer_until` / `reopen_reminder` / `deferred_by_user_id` and bumping `version`, and
   * insert one notice per reminded request. Returns what was reopened.
   */
  reopenDue(notice: ReopenNotice): Promise<readonly DueDeferredRequest[]>;
}

/** The notice row's fixed parts. */
export interface ReopenNotice {
  readonly type: string;
  readonly objectType: string;
  /** The dedupe key for one reopen of one request at one version — replay-proof. */
  dedupeKeyOf(request: DueDeferredRequest): string;
}

export interface RequestDeferSweepResult {
  readonly reopened: number;
  readonly reminded: number;
}

/** The in-app notice the reminded deferrer receives. */
export const REQUEST_REOPENED_NOTICE: ReopenNotice = {
  type: 'client_request.reopened.v1',
  objectType: 'client_request',
  dedupeKeyOf: (request) => `client_request.reopened:${request.id}:${String(request.version)}`,
};

/**
 * Run one sweep. Idempotent: a second run with nothing due reopens nothing and reports zeros,
 * because the store's predicate selects only rows still `deferred` with a past `defer_until`.
 */
export async function sweepDeferredRequests(
  store: RequestDeferSweepStore,
): Promise<RequestDeferSweepResult> {
  const reopened = await store.reopenDue(REQUEST_REOPENED_NOTICE);
  return {
    reopened: reopened.length,
    reminded: reopened.filter((request) => request.remindUserId !== null).length,
  };
}
