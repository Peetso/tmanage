import type { ApiClient } from './client';

/**
 * The client-portal access log — SEC / Client portal (module 13, x237). `GET
 * .../projects/:id/portal-access-log`, behind `project.manage`.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired Exact with the API projection
 * (`PortalAccessLogView`) in the `e2e/contracts` shape check so the two cannot drift. This is the
 * **internal** audit read — a record of what a client looked at, tenant-scoped by the API from the
 * caller's membership. It is never a portal (client-facing) surface: a client cannot read the log.
 * The projection is deliberately narrow — a fixed `resourceKind` and an instant, never a title, a
 * body or a token.
 */

/** The kind of portal resource an event records. Mirrors the API's `PortalAccessResourceKind`. */
export type PortalAccessResourceKind =
  | 'project'
  | 'work_item'
  | 'deliverable'
  | 'deliverable_file'
  | 'update';

/**
 * One client access event. Paired Exact with the API's `PortalAccessLogView` in the contracts gate;
 * every field is a stable identifier or a non-sensitive summary.
 */
export interface PortalAccessLogEvent {
  readonly id: string;
  readonly projectId: string;
  /** The client membership that accessed the resource. */
  readonly clientMemberId: string;
  readonly resourceKind: PortalAccessResourceKind;
  /** The server's record time, ISO-8601. */
  readonly accessedAt: string;
}

/**
 * The read's response body. An object-literal `type` alias rather than an exported interface, so the
 * contracts gate does not enumerate it as a second response shape: the paired projection is the row
 * {@link PortalAccessLogEvent}, and the wrapper leaves room for a later cursor without reshaping.
 */
type PortalAccessLogPage = { readonly events: readonly PortalAccessLogEvent[] };

/** The largest page the audit route returns — the API's `VIEWER_MAX_PAGE_SIZE`. */
export const MAX_PORTAL_ACCESS_PAGE = 50;

/** The viewer's paging. Named `…Options`, so the contracts gate treats it as request-side. */
export interface ListPortalAccessLogOptions {
  /** `1..50`; the API defaults to 50 and rejects an out-of-range value with a 400. */
  readonly limit?: number;
  /** Keyset cursor — the id of the oldest row already held; the API returns the ones before it. */
  readonly before?: string;
}

export async function listPortalAccessLog(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  options: ListPortalAccessLogOptions = {},
): Promise<readonly PortalAccessLogEvent[]> {
  const parameters = new URLSearchParams();
  if (options.limit !== undefined) parameters.set('limit', String(options.limit));
  if (options.before) parameters.set('before', options.before);

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<PortalAccessLogPage>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/portal-access-log${suffix}`,
  });
  return data.events;
}
