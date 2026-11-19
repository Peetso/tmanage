import type { ActivityAction, ActivityKind, ActivitySource } from '@tmanage/domain';
import type { ApiClient } from './client';

/**
 * 62-A2 (B02) — the Activity tab of a project and of a client.
 *
 * - **`GET …/projects/:projectId/activity`** (`work.read`) and
 *   **`GET …/client-organizations/:clientOrganizationId/activity`** (`org.manage`) return one page,
 *   newest first. The API authorises the project or client first (404 otherwise) and leaves out
 *   every entry the viewer could not open on its own screen; money entries need finance access.
 * - An entry is a phrase built from the action and, where the record has one, its name now
 *   (`subject`, D2; only for an entry the viewer may read): the phrase (`phraseKey` in the
 *   catalogue, with `{actor}` and `{subject}` holes; `summary` the English fallback) and a link
 *   to the record (`objectType` + `objectId`). Never a body or an amount.
 * - Paging: pass `nextCursor` back as `cursor`; `null` means there is nothing older. The first
 *   page carries `total` (D3, "Showing 25 of 46"), `null` on the pages after it.
 */

export type { ActivityAction, ActivityKind, ActivitySource } from '@tmanage/domain';

export interface ActivityEntry {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly action: ActivityAction;
  readonly phraseKey: string;
  readonly summary: string;
  /** The record's name now (task title, file name, invoice number); `null` when it has none. */
  readonly subject: string | null;
  /** The user who acted; `null` for a system action. */
  readonly actorUserId: string | null;
  readonly objectType: ActivitySource;
  readonly objectId: string;
  readonly projectId: string | null;
  readonly clientOrganizationId: string | null;
  /** ISO-8601 instant. */
  readonly occurredAt: string;
}

/** How many entries the viewer may read under the filters; `atLeast` past the API's scan cap. */
export interface ActivityTotal {
  readonly count: number;
  readonly atLeast: boolean;
}

export interface ActivityPage {
  readonly entries: readonly ActivityEntry[];
  readonly nextCursor: string | null;
  /** On the first page only; `null` on the pages after it. */
  readonly total: ActivityTotal | null;
}

export interface ActivityQuery {
  readonly kind?: ActivityKind;
  /** A user id. */
  readonly person?: string;
  /** A day (`YYYY-MM-DD`) or an ISO instant, inclusive. */
  readonly from?: string;
  /** A day (`YYYY-MM-DD`, inclusive) or an ISO instant (exclusive). */
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

function querySuffix(query: ActivityQuery): string {
  const parameters = new URLSearchParams();
  if (query.kind !== undefined) parameters.set('kind', query.kind);
  if (query.person !== undefined) parameters.set('person', query.person);
  if (query.from !== undefined) parameters.set('from', query.from);
  if (query.to !== undefined) parameters.set('to', query.to);
  if (query.cursor !== undefined) parameters.set('cursor', query.cursor);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));
  const text = parameters.toString();
  return text === '' ? '' : `?${text}`;
}

export async function listProjectActivity(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  query: ActivityQuery = {},
): Promise<ActivityPage> {
  const { data } = await client.request<ActivityPage>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(projectId)}/activity${querySuffix(query)}`,
  });
  return data;
}

export async function listClientActivity(
  client: ApiClient,
  organizationSlug: string,
  clientOrganizationId: string,
  query: ActivityQuery = {},
): Promise<ActivityPage> {
  const { data } = await client.request<ActivityPage>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-organizations/${encodeURIComponent(clientOrganizationId)}/activity${querySuffix(query)}`,
  });
  return data;
}
