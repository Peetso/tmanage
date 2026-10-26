import type { ApiClient } from './client';

/**
 * A work item's activity timeline — x291 (Work module 7), read-only.
 *
 * The API projection is `WorkActivityEntryView`; this is its web mirror, paired `Exact` in
 * `e2e/contracts`. A merged, chronological feed of what already happened to the item — status
 * changes and other audited moves alongside member comments — newest first. `actorId` is a
 * display handle (a user id for an audited move, an author membership for a comment), never an
 * email; `null` means a system-initiated action. There is no write path here.
 */
export interface WorkActivityEntry {
  readonly id: string;
  readonly kind: 'audit' | 'comment';
  readonly action: string;
  readonly actorId: string | null;
  readonly summary: string;
  readonly occurredAt: string;
  /**
   * AUT-08. `'ai_assistant'` when the move was made through the member's AI assistant (a
   * personal access token / the MCP connector), so the timeline can name the person and the app;
   * `null` for an ordinary move or comment.
   */
  readonly via: 'ai_assistant' | null;
  /** The connected app's name ("Claude") for an AI move when it was recorded; else `null`. */
  readonly viaApp: string | null;
}

export async function listWorkActivity(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly WorkActivityEntry[]> {
  const { data } = await client.request<{ activity: readonly WorkActivityEntry[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/activity`,
  });
  return data.activity;
}
