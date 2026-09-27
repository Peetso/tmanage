import type { ApiClient } from './client';

/**
 * CHAT "my mentions" (x254) — the caller's own recent mentions across the conversations they belong
 * to. Read-only, behind the `conversation.read` capability the API enforces; the API scopes the list
 * to the acting membership and drops any mention in a conversation the caller is not in, so no channel
 * name or message body leaks from a room the caller cannot read. This module wraps only what the
 * My Mentions screen consumes, the discipline the contracts gate enforces on this folder.
 */

/**
 * One mention — paired Exact with the API's `MentionView` in the contracts gate
 * (`e2e/contracts/api-web-shapes.ts`). `organizationId`/`membershipId` are absent on both sides: the
 * wire projection never echoes the tenant id, and the membership is always the caller's own.
 */
export interface MentionSummary {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationName: string;
  readonly projectId: string;
  readonly authorUserId: string;
  /** The message body as stored (plain text of what was said). */
  readonly body: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function listBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/mentions`;
}

/** List the caller's mentions, newest first. `page` is 1-based; omitted reads the first page. */
export async function listMyMentions(
  client: ApiClient,
  organizationSlug: string,
  page?: number,
): Promise<readonly MentionSummary[]> {
  const query = page === undefined ? '' : `?page=${encodeURIComponent(String(page))}`;
  const { data } = await client.request<{ mentions: readonly MentionSummary[] }>({
    path: `${listBase(organizationSlug)}${query}`,
  });
  return data.mentions;
}
