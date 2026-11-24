import type { ApiClient } from './client';

/**
 * People & capacity — module 14, the read behind the `/people` screen (audit #4).
 *
 * Tenant-scoped like `members.ts`: the slug is in the path, the API resolves it against a
 * membership row before the handler runs, and a slug the caller has no membership in is refused.
 * The route needs `work.read`, which no client role holds, so the portal cannot reach this list.
 *
 * This is the capacity directory, distinct from the D16 picker (`members.ts`): the same people,
 * plus how many projects each is on, the sign-in address (staff only: the API sends null to
 * anyone else), when each was last active, and the membership version the role change sends.
 */

export interface PersonSummary {
  /** What the API stores on a work item. Shown for reference, never typed by a person. */
  readonly userId: string;
  readonly displayName: string;
  /** r-people's second line. Null when the caller is not an internal principal. */
  readonly email: string | null;
  readonly role: string;
  /**
   * H1: a custom role's own name, sent for every viewer; null for a built-in role (named in the
   * reader's language). Web and API ship as one app, so it is always sent.
   */
  readonly roleName: string | null;
  /** QA-FIX-P S2 (ADR-0014): sent only to a viewer who manages members (`org.manage`). */
  readonly status?: string;
  /** How many of this organization's projects the person is a member of. */
  readonly projectCount: number;
  /** 60-07 (S1 "Job title"): the member's own title in this workspace, or null. */
  readonly jobTitle: string | null;
  /** The membership's compare-and-swap token for `PATCH members/:userId/role` (409 when stale). */
  readonly version: number;
  /** LAST ACTIVE: the latest sign-in or session refresh (ISO), or null for never. */
  readonly lastActiveAt: string | null;
  /** The profile route's id (PEO-02). Optional only while an older API is still deployed. */
  readonly membershipId: string;
  /** PEO-01 columns. An older API omits them; the screen then shows no team, nothing declared. */
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  readonly openCommitments: number;
  readonly overdueCommitments: number;
  /** The first window the person declared in the next two weeks, or null for none. */
  readonly declared: {
    readonly kind: string;
    readonly startDate: string;
    readonly endDate: string;
  } | null;
}

export interface ListPeopleQuery {
  /**
   * A fragment of the name to search for, sent to the server. One request is one page (default
   * 50, ceiling 200), so without a search the fifty-first person is unreachable; `q` is how the
   * roster beyond the first page is reached, answered on the server on purpose. Blank is absent.
   */
  readonly q?: string;
  readonly limit?: number;
}

/**
 * This organization's active people, by name, each with a project count.
 *
 * `nextAfter` is returned rather than dropped, so a full page is a visible fact to a caller
 * rather than a silent truncation.
 */
export async function listPeople(
  client: ApiClient,
  organizationSlug: string,
  options: ListPeopleQuery = {},
): Promise<{ readonly people: readonly PersonSummary[]; readonly nextAfter: string | null }> {
  const parameters = new URLSearchParams();
  if (options.q !== undefined && options.q.trim() !== '') parameters.set('q', options.q.trim());
  if (options.limit !== undefined) parameters.set('limit', String(options.limit));

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<{
    people: readonly PersonSummary[];
    nextAfter: string | null;
  }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/people${suffix}`,
  });
  return data;
}
