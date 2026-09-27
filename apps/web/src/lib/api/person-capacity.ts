import type { ApiClient } from './client';

/**
 * People capacity (module 14, x170).
 *
 * This module wraps the capacity API: read one member's weekly capacity and set (create or replace)
 * it. The one exported response shape is {@link PersonCapacity}, paired Exact with the API's
 * `PersonCapacityView` in the contracts gate. `organizationId` is absent on both sides — the wire
 * projection never echoes the tenant id.
 */

/** One member's weekly capacity — paired Exact with the API's `PersonCapacityView`. */
export interface PersonCapacity {
  readonly membershipId: string;
  readonly weeklyHours: number;
  /** An ISO-8601 date, `YYYY-MM-DD` — the day the figure takes effect. */
  readonly effectiveFrom: string;
  /** An ISO-8601 instant. */
  readonly updatedAt: string;
}

/** The fields a set sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface SetPersonCapacityInput {
  readonly weeklyHours: number;
  readonly effectiveFrom: string;
}

function base(organizationSlug: string, membershipId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/people/${encodeURIComponent(
    membershipId,
  )}/capacity`;
}

/** Read one member's capacity — `null` when none has been set yet. */
export async function getPersonCapacity(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
): Promise<PersonCapacity | null> {
  const { data } = await client.request<{ capacity: PersonCapacity | null }>({
    path: base(organizationSlug, membershipId),
  });
  return data.capacity;
}

/** Set (create or replace) one member's capacity. */
export async function setPersonCapacity(
  client: ApiClient,
  organizationSlug: string,
  membershipId: string,
  input: SetPersonCapacityInput,
): Promise<PersonCapacity> {
  const { data } = await client.request<PersonCapacity>({
    method: 'PUT',
    path: base(organizationSlug, membershipId),
    body: input,
  });
  return data;
}
