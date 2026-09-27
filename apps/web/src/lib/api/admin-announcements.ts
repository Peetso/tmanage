import type { ApiClient } from './client';

/**
 * Org-wide admin announcement banners (Administration module 18, x276). Post an announcement and delete
 * one (behind `org.manage` on the server), and read the announcements active right now (behind
 * `work.read`, an authenticated member). Hand-written for the boundary reason `errors.ts` gives; this
 * module wraps only what the announcements screen and the app-shell banner consume.
 */

/**
 * One announcement as a member sees it — the paired contract view of the API's `AnnouncementView`
 * (`apps/api/.../admin/announcements.service.ts`). `organizationId` and the posting membership are
 * absent on both sides: the wire projection never echoes the tenant id, and the author is an internal
 * identifier a banner reader has no need of.
 */
export interface AnnouncementSummary {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** ISO-8601 instant, or null for an open bound. */
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/** What the compose form sends. Absent/empty bounds are open windows on the server. */
export interface CreateAnnouncementInput {
  readonly title: string;
  readonly body: string;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
}

function adminBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/announcements`;
}

function memberBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/announcements`;
}

/** List the org's announcements active right now, for any member. */
export async function listActiveAnnouncements(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly AnnouncementSummary[]> {
  const { data } = await client.request<{ announcements: readonly AnnouncementSummary[] }>({
    path: memberBase(organizationSlug),
  });
  return data.announcements;
}

/** Post an announcement for the org (admin). */
export async function createAnnouncement(
  client: ApiClient,
  organizationSlug: string,
  input: CreateAnnouncementInput,
): Promise<AnnouncementSummary> {
  const { data } = await client.request<AnnouncementSummary>({
    method: 'POST',
    path: adminBase(organizationSlug),
    body: input,
  });
  return data;
}

/** Delete an announcement (admin). Idempotent on the server: an already-gone id is still resolved 404. */
export async function deleteAnnouncement(
  client: ApiClient,
  organizationSlug: string,
  id: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${adminBase(organizationSlug)}/${encodeURIComponent(id)}`,
  });
}
