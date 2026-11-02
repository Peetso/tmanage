import type { ApiClient } from './client';
import type { InboxItem } from './inbox';

/**
 * INBOX snooze (IN-01/IN-02, x259) — a member snoozes an inbox bundle until a chosen time so it drops
 * out of their active inbox until then, un-snoozes it, and lists their snoozes.
 *
 * Behind `work.read` on the server (the same capability `InboxController` requires); a caller without
 * it gets the ordinary 403 the shared client turns into an error. The tenant is the slug in the path
 * resolved against the caller's membership, and the *member* is the authenticated principal — never a
 * value this client supplies — so it can only ever read or write the caller's own snoozes. The bundle
 * id is the inbox's own `objectType:objectId`, the same string `markBundleRead` takes.
 *
 * Paired with the API projection (`InboxSnoozeService.InboxSnoozeView`) so the two shapes cannot
 * drift.
 */

/** One snoozed bundle — paired Exact with the API view. Dates are ISO strings on the wire. */
export interface InboxSnooze {
  readonly bundleId: string;
  readonly snoozedUntil: string;
  /** A21: true when the bundle was marked Done (a snooze that never ends). */
  readonly done: boolean;
  readonly createdAt: string;
}

/** The caller's snoozes the GET route returns. */
export interface InboxSnoozeView {
  readonly snoozes: readonly InboxSnooze[];
}

function bundlePath(organizationSlug: string, bundleId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/${encodeURIComponent(
    bundleId,
  )}/snooze`;
}

export async function listSnoozed(
  client: ApiClient,
  organizationSlug: string,
): Promise<InboxSnoozeView> {
  const { data } = await client.request<InboxSnoozeView>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/snoozed`,
  });
  return data;
}

/** Snooze a bundle until `until` (an ISO-8601 date-time in the future). */
export async function snoozeBundle(
  client: ApiClient,
  organizationSlug: string,
  bundleId: string,
  until: string,
): Promise<InboxSnoozeView> {
  const { data } = await client.request<InboxSnoozeView>({
    method: 'PUT',
    path: bundlePath(organizationSlug, bundleId),
    body: { until },
  });
  return data;
}

/** A21: mark a bundle Done — it leaves the active inbox for the Done view until un-snoozed. */
export async function markBundleDone(
  client: ApiClient,
  organizationSlug: string,
  bundleId: string,
): Promise<InboxSnoozeView> {
  const { data } = await client.request<InboxSnoozeView>({
    method: 'PUT',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/inbox/${encodeURIComponent(
      bundleId,
    )}/done`,
  });
  return data;
}

/** Un-snooze a bundle. */
export async function unsnoozeBundle(
  client: ApiClient,
  organizationSlug: string,
  bundleId: string,
): Promise<InboxSnoozeView> {
  const { data } = await client.request<InboxSnoozeView>({
    method: 'DELETE',
    path: bundlePath(organizationSlug, bundleId),
  });
  return data;
}

/**
 * The bundle ids that are still snoozed at `now` — those whose `snoozedUntil` is strictly in the
 * future. `now` is a bound `Date` the caller passes (a single `new Date()` per render), never the
 * server clock, so a snooze that has elapsed reappears the moment its instant passes.
 */
export function activeSnoozeBundleIds(
  snoozes: readonly InboxSnooze[],
  now: Date,
): ReadonlySet<string> {
  const at = now.getTime();
  return new Set(
    snoozes
      .filter((snooze) => new Date(snooze.snoozedUntil).getTime() > at)
      .map((snooze) => snooze.bundleId),
  );
}

/**
 * The active inbox with snoozed bundles removed — a bundle whose `snoozedUntil` is in the future does
 * not show until then. The filtering is the client's, over the same `bundleId` the inbox page and the
 * snooze routes share; the server's inbox is unchanged.
 */
export function filterActiveInbox(
  items: readonly InboxItem[],
  snoozes: readonly InboxSnooze[],
  now: Date,
): readonly InboxItem[] {
  const snoozed = activeSnoozeBundleIds(snoozes, now);
  return items.filter((item) => !snoozed.has(item.bundleId));
}
