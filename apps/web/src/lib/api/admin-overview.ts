import type { ApiClient } from './client';

/**
 * The Administration overview endpoint — module 18 (x175). `GET .../admin/overview`, behind
 * `org.manage` on the server (the same org-administration capability the audit viewer, members admin
 * and settings sit behind); a caller without it gets the ordinary 403 the shared client turns into an
 * error.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection
 * (`AdminOverviewView`) in the `e2e/contracts` shape check so the two cannot drift. The read is
 * tenant-scoped on the server from the caller's membership — there is no organization argument here
 * beyond the slug in the path — and the counts are tenant-scoped in SQL and re-checked on the server,
 * so this never returns another tenant's numbers.
 */

/**
 * The org health roll-up. `activeMembers` is the current active memberships; `seatsUsed` is every
 * membership holding a seat (active, invited or suspended); `storageBytesUsed` is the organization's
 * storage counter; `auditEventsWindow` is the audit events recorded over the last `auditWindowDays`
 * days; `openOffboardings` is the offboardings in progress (suspended memberships).
 */
export interface AdminOverviewView {
  readonly activeMembers: number;
  readonly seatsUsed: number;
  readonly storageBytesUsed: number;
  readonly auditWindowDays: number;
  readonly auditEventsWindow: number;
  readonly openOffboardings: number;
  readonly computedAt: string;
}

export async function fetchAdminOverview(
  client: ApiClient,
  organizationSlug: string,
): Promise<AdminOverviewView> {
  const { data } = await client.request<AdminOverviewView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/overview`,
  });
  return data;
}

/**
 * OPS-1's "N invitations waiting": every seat-holding membership that is neither active nor being
 * offboarded is an invitation not yet accepted. Never negative, whatever the counters say.
 */
export function invitationsWaiting(view: AdminOverviewView): number {
  return Math.max(0, view.seatsUsed - view.activeMembers - view.openOffboardings);
}

const RELATIVE_STEPS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.35],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

/**
 * OPS-1's activity times — "2 minutes ago", "yesterday", "3 days ago" — in the reader's language
 * (`Intl.RelativeTimeFormat`, so Arabic reads "قبل دقيقتين", "أمس"). An unparseable value is shown
 * verbatim rather than as `Invalid Date`.
 */
export function relativeWhen(iso: string, now: Date, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  let value = (at.getTime() - now.getTime()) / 1000;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of RELATIVE_STEPS) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit);
    value /= size;
  }
  return format.format(Math.round(value), 'year');
}
