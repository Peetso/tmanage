import type { ApiClient } from './client';

/**
 * The member directory — D16, behind every field that used to ask for a user id.
 *
 * Tenant-scoped like `projects.ts`: the slug is in the path, the API resolves it against a
 * membership row before the handler runs, and a slug the caller has no membership in is
 * refused. The route needs `work.read`, which no client role holds, so the portal cannot
 * reach this list at all.
 */

export interface MemberSummary {
  /** What the API stores on a work item. Never typed by a person — see `MemberSelect`. */
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  /** QA-FIX-P S2 (ADR-0014): sent only to a viewer who manages members (`org.manage`). */
  readonly status?: string;
  /**
   * 60-08 (plan 60 v2 S7): a person or an AI employee. Absent (an older answer) reads as a person.
   * AI employees are listed only while the server's AI-employee switch is on.
   */
  readonly kind?: 'human' | 'ai';
  /** 60-08: an AI employee's job line, state and why a picker cannot offer him now. */
  readonly ai?: AiMemberMark;
}

/** Why an AI employee cannot be chosen in a picker now; the server decides it (AR-9). */
export type AiAvailability = 'available' | 'paused' | 'not_connected' | 'switched_off';

/** The AI part of a directory row (S7: the mark, the job line, the reason a row is dimmed). */
export interface AiMemberMark {
  readonly jobTitle: string;
  readonly status: 'active' | 'paused';
  readonly connected: boolean;
  readonly availability: AiAvailability;
}

/** Is this directory row an AI employee? */
export function isAiMember(member: Pick<MemberSummary, 'kind'> | undefined): boolean {
  return member?.kind === 'ai';
}

export interface ListMembersQuery {
  /**
   * A fragment of the name to search for, sent to the server.
   *
   * One request is one page — the API's default is 50 and its ceiling is 200 — so without a
   * search the fifty-first member of an organization is somebody this client has never been
   * sent and therefore somebody no field here can assign work to. `q` is how the roster beyond
   * the first page is reached, and it is answered by the server on purpose: paging the whole
   * staff list into the browser to filter it there would download a roster to answer a
   * keystroke. Blank is the same as absent.
   */
  readonly q?: string;
  readonly limit?: number;
}

/**
 * This organization's active members, by name — all of them, or the ones matching `q`.
 *
 * `nextAfter` is returned rather than dropped, so a page that was full is a visible fact to a
 * caller rather than a silent truncation.
 */
export async function listMembers(
  client: ApiClient,
  organizationSlug: string,
  options: ListMembersQuery = {},
): Promise<{ readonly members: readonly MemberSummary[]; readonly nextAfter: string | null }> {
  const parameters = new URLSearchParams();
  if (options.q !== undefined && options.q.trim() !== '') parameters.set('q', options.q.trim());
  if (options.limit !== undefined) parameters.set('limit', String(options.limit));

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<{
    members: readonly MemberSummary[];
    nextAfter: string | null;
  }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/members${suffix}`,
  });
  return data;
}
