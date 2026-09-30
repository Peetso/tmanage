import type { ApiClient } from './client';

/**
 * The client portal's announcement banners — POR client portal (x304).
 *
 * A pinned banner an internal staffer posts to one client organization's portal, distinct from the
 * updates feed (`portal.ts`). Two shapes, the same split the API makes: {@link PortalAnnouncement} is
 * the internal record returned by create (behind `client_member.manage`), and
 * {@link ClientPortalAnnouncement} is the client projection the portal reads (behind
 * `client_projection.read`) — it carries **no author**, because `12-PERMISSION-MATRIX` §4 excludes
 * staff from what a client is shown. A shared type would be the first step back towards building the
 * client view by deleting fields, which `25-AUTH-AND-TENANT-ISOLATION` §7 forbids.
 */

/** The internal record returned by create — carries the author. Never rendered on the client read. */
export interface PortalAnnouncement {
  readonly id: string;
  readonly clientId: string;
  readonly title: string;
  readonly body: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

/**
 * A banner as the portal is told it. What is absent is the point: there is no author and no
 * `createdAt` — only the title, body and the active window.
 */
export interface ClientPortalAnnouncement {
  readonly id: string;
  readonly clientId: string;
  readonly title: string;
  readonly body: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
}

/**
 * The banners active now for one client — the portal read.
 *
 * The client is named in the path. The API answers 404 — not an empty list — for a client the caller
 * cannot read, so a not-found is "not yours", never "no banners".
 */
export async function listPortalAnnouncements(
  client: ApiClient,
  organizationSlug: string,
  clientId: string,
): Promise<readonly ClientPortalAnnouncement[]> {
  const { data } = await client.request<{ announcements: readonly ClientPortalAnnouncement[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/${encodeURIComponent(clientId)}/announcements`,
  });
  return data.announcements;
}

/** What an internal staffer posts. The tenant and the author come from the session, never this body. */
export interface PostPortalAnnouncementInput {
  readonly title: string;
  readonly body: string;
  /** Omitted means "live now"; ISO-8601 on the wire. */
  readonly startsAt?: string;
  /** Omitted or `null` means open-ended. */
  readonly endsAt?: string | null;
}

/**
 * Post a banner — internal, behind `client_member.manage`. The API answers 404 for a client the
 * caller cannot manage or that is not in this tenant, and 400 for an empty title or a window whose
 * `endsAt` is not after `startsAt`.
 */
export async function postPortalAnnouncement(
  client: ApiClient,
  organizationSlug: string,
  clientId: string,
  input: PostPortalAnnouncementInput,
): Promise<PortalAnnouncement> {
  const { data } = await client.request<PortalAnnouncement>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/${encodeURIComponent(clientId)}/announcements`,
    body: input,
  });
  return data;
}

/** Retract a banner — internal, behind `client_member.manage`. Idempotent: 204 whether or not it existed. */
export async function deletePortalAnnouncement(
  client: ApiClient,
  organizationSlug: string,
  clientId: string,
  announcementId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/${encodeURIComponent(clientId)}/announcements/${encodeURIComponent(announcementId)}`,
  });
}
