import type { ApiClient } from './client';

/**
 * SRCH quick-access pins (x290).
 *
 * A member's own pinned entities (pin/list/unpin) for quick access from the Search module, served
 * under `.../search/pins` behind the `search.use` capability. Every row is the caller's own — the
 * API scopes each read, the pin and the unpin by tenant and membership — so the client renders what
 * it is given without a second check. A pin is a bare type + id reference plus a cached `label`; the
 * entity itself is read from its own read side, so a pin to something the caller can no longer read
 * simply renders as unavailable.
 */

/** A pin as the screen reads it — paired Exact with the API's `SearchPinView`. */
export interface SearchPin {
  readonly id: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly label: string;
  readonly createdAt: string;
}

/** The pin body — request-side, so the contracts gate drops the `Input` suffix. */
export interface PinEntityInput {
  readonly objectType: string;
  readonly objectId: string;
  readonly label: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/search`;
}

export async function listSearchPins(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly SearchPin[]> {
  const { data } = await client.request<{ pins: readonly SearchPin[] }>({
    path: `${base(organizationSlug)}/pins`,
  });
  return data.pins;
}

export async function pinEntity(
  client: ApiClient,
  organizationSlug: string,
  input: PinEntityInput,
): Promise<SearchPin> {
  const { data } = await client.request<SearchPin>({
    method: 'PUT',
    path: `${base(organizationSlug)}/pins`,
    body: input,
  });
  return data;
}

export async function unpinEntity(
  client: ApiClient,
  organizationSlug: string,
  pinId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/pins/${encodeURIComponent(pinId)}`,
  });
}
