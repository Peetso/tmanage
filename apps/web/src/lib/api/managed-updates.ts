import type { ApiClient } from './client';

/**
 * A10 — one client update as the studio's own updates list reads it (`GET …/projects/:id/updates`,
 * behind `project.manage`, never the portal path).
 *
 * Unlike `PortalUpdate` it names the author ("Published <date> by <name>"), carries the linked
 * milestone, and — for a published update — the first time the client opened the project's updates
 * after it was posted, which the unpublish confirmation warns about.
 */
export interface ManagedUpdate {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  readonly published: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly authorName: string;
  readonly milestone: {
    readonly id: string;
    readonly title: string;
    /** `YYYY-MM-DD`, or null when the milestone has no due date. */
    readonly dueOn: string | null;
  } | null;
  readonly clientOpened: { readonly clientName: string; readonly openedAt: string } | null;
}

/** One project's client updates, drafts included, newest first. */
export async function listManagedUpdates(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ManagedUpdate[]> {
  const { data } = await client.request<{ updates: readonly ManagedUpdate[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/updates`,
  });
  return data.updates;
}
