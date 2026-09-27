import type { ApiClient } from './client';

/**
 * CAL-04 focus blocks (x255) — a member's own protected time on the calendar. Create a block, list the
 * caller's blocks in a bounded window, and delete one. All are behind the `work.read` capability the API
 * enforces (a member's own personal calendar); the tenant is the slug in the path resolved against the
 * caller's membership, and the *member* is the authenticated principal — never a value this client
 * supplies — so it can only ever read, create, or delete the caller's own blocks.
 */

/**
 * One of the caller's focus blocks — paired Exact with the API's `FocusBlockView`.
 * `organizationId`/`membershipId` are absent on both sides: the wire projection never echoes the tenant
 * id, and the membership is always the caller's own.
 */
export interface FocusBlockView {
  readonly id: string;
  /** ISO-8601 instant. */
  readonly startsAt: string;
  /** ISO-8601 instant. */
  readonly endsAt: string;
  readonly title: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/** The fields a create request carries. */
export interface CreateFocusBlockInput {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly title: string;
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/calendar/focus-blocks`;
}

/** List the caller's focus blocks that start within `[from, to)`. */
export async function listFocusBlocks(
  client: ApiClient,
  organizationSlug: string,
  from: string,
  to: string,
): Promise<readonly FocusBlockView[]> {
  const query = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const { data } = await client.request<{ blocks: readonly FocusBlockView[] }>({
    path: `${base(organizationSlug)}${query}`,
  });
  return data.blocks;
}

/** Create a focus block for the caller. */
export async function createFocusBlock(
  client: ApiClient,
  organizationSlug: string,
  input: CreateFocusBlockInput,
): Promise<FocusBlockView> {
  const { data } = await client.request<FocusBlockView>({
    method: 'POST',
    path: base(organizationSlug),
    body: input,
  });
  return data;
}

/** Delete one of the caller's focus blocks. */
export async function deleteFocusBlock(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug)}/${encodeURIComponent(id)}`,
  });
}
