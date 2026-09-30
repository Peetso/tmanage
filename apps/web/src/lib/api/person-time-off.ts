import type { ApiClient } from './client';

/**
 * Person time-off (People module 14, x325) — a manager files dated absences against a person (start
 * date, end date, kind, optional note), lists a person's entries, and removes one, with an optional
 * `from`/`to` overlap window on the list. The write surface (create/delete) is behind `org.manage` on
 * the server; the read is behind `work.read`. A caller without the capability gets the ordinary 403
 * the shared client turns into an error, and a cross-tenant or unknown person id gets a 404. The
 * tenant is the slug in the path resolved against the caller's membership, never a value this client
 * supplies.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** One time-off entry. Paired Exact with the API `PersonTimeOffView`. */
export interface PersonTimeOffView {
  readonly id: string;
  readonly personUserId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly kind: string;
  readonly note: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/** The body a create sends. Request-side (name ends `Input`), so the contracts check ignores it. */
export interface CreatePersonTimeOffInput {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly kind: string;
  readonly note?: string | null;
}

/** A bounded overlap window for the list read. Both inclusive ISO-8601 dates (`YYYY-MM-DD`). */
export interface PersonTimeOffRange {
  readonly from: string;
  readonly to: string;
}

function basePath(organizationSlug: string, userId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/${encodeURIComponent(
    userId,
  )}/time-off`;
}

export async function listPersonTimeOff(
  client: ApiClient,
  organizationSlug: string,
  userId: string,
  range?: PersonTimeOffRange,
): Promise<readonly PersonTimeOffView[]> {
  const query =
    range === undefined
      ? ''
      : `?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
  const { data } = await client.request<{ entries: PersonTimeOffView[] }>({
    path: `${basePath(organizationSlug, userId)}${query}`,
  });
  return data.entries;
}

export async function createPersonTimeOff(
  client: ApiClient,
  organizationSlug: string,
  userId: string,
  entry: CreatePersonTimeOffInput,
): Promise<PersonTimeOffView> {
  const { data } = await client.request<PersonTimeOffView>({
    method: 'POST',
    path: basePath(organizationSlug, userId),
    body: entry,
  });
  return data;
}

export async function deletePersonTimeOff(
  client: ApiClient,
  organizationSlug: string,
  userId: string,
  entryId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${basePath(organizationSlug, userId)}/${encodeURIComponent(entryId)}`,
  });
}
