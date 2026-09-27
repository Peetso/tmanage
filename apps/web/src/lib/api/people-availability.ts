import type { ApiClient } from './client';

/**
 * Member availability / out-of-office windows (People module 14, x218) — a member's own dated OOO
 * windows (add / list / remove) and the team read of one member's windows. Behind `work.read` on the
 * server (the internal-read capability the sibling people slices reuse); a caller without it gets the
 * ordinary 403 the shared client turns into an error. The own surface's subject is the authenticated
 * principal — never a value this client supplies — so it can only ever read, add, or remove the
 * caller's own windows.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift.
 */

/** One out-of-office window. Paired Exact with the API `AvailabilityView`. */
export interface AvailabilityView {
  readonly id: string;
  readonly membershipId: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly kind: string;
  readonly note: string | null;
  readonly createdAt: string;
}

/** The body a create sends. Request-side (name ends `Input`), so the contracts check ignores it. */
export interface CreateAvailabilityWindowInput {
  readonly startDate: string;
  readonly endDate: string;
  readonly kind: string;
  readonly note?: string | null;
}

function ownPath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/availability`;
}

function memberPath(organizationSlug: string, membershipId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/${encodeURIComponent(
    membershipId,
  )}/availability`;
}

export async function listOwnAvailability(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly AvailabilityView[]> {
  const { data } = await client.request<{ windows: AvailabilityView[] }>({
    path: ownPath(organizationSlug),
  });
  return data.windows;
}

export async function listMemberAvailability(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<readonly AvailabilityView[]> {
  const { data } = await client.request<{ windows: AvailabilityView[] }>({
    path: memberPath(organizationSlug, membershipId),
  });
  return data.windows;
}

export async function createAvailabilityWindow(
  client: ApiClient,
  organizationSlug: string,
  window: CreateAvailabilityWindowInput,
): Promise<AvailabilityView> {
  const { data } = await client.request<AvailabilityView>({
    method: 'POST',
    path: ownPath(organizationSlug),
    body: window,
  });
  return data;
}

export async function deleteAvailabilityWindow(
  client: ApiClient,
  organizationSlug: string,
  availabilityId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${ownPath(organizationSlug)}/${encodeURIComponent(availabilityId)}`,
  });
}
