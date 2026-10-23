import type { ApiClient } from './client';

/**
 * The studio's side of a client request — `REQ-001`'s and `REQ-002`'s internal endpoints.
 *
 * A separate module from `portal.ts`, for the same reason the API keeps two services: these are
 * the **internal record**, and `portal.ts` is the client projection.
 * `25-AUTH-AND-TENANT-ISOLATION` §7 forbids building the second from the first, and a shared
 * type here would be the first step towards exactly that.
 *
 * What is here and not in `portal.ts` is the point: the internal `state` including `triage`, the
 * linked work item, the id of the person who submitted it, and the name of the client
 * organization that asked.
 */

/** `23-ERD` §6's states, as the studio sees them. `triage` is here; on the portal it is not. */
export type ClientRequestState =
  | 'submitted'
  | 'triage'
  | 'needs_clarification'
  | 'accepted'
  | 'deferred'
  | 'declined'
  | 'planned'
  | 'delivered'
  | 'withdrawn';

export interface ClientRequestRecord {
  readonly id: string;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  /** Which client asked, in words. Null when the row could not be read — see the API's note. */
  readonly clientOrganizationName: string | null;
  readonly submittedByUserId: string;
  readonly title: string;
  readonly category: string;
  readonly description: string;
  readonly urgencyReason: string | null;
  /** What the client asked for, as `YYYY-MM-DD`. Never a commitment. */
  readonly desiredAt: string | null;
  readonly state: ClientRequestState;
  readonly clarificationQuestion: string | null;
  readonly clientVisibleReason: string | null;
  readonly clientSafeScopeSummary: string | null;
  readonly commitment: 'committed' | 'unscheduled' | null;
  readonly committedAt: string | null;
  readonly linkedWorkItemId: string | null;
  /** A7: who sent it, by name. Null when the API could not name them. */
  readonly submittedByName: string | null;
  /** A7: the day a deferred request comes back, `YYYY-MM-DD`; null when not parked. */
  readonly deferUntil: string | null;
  /** A7: whether the deferrer asked to be reminded when it reopens. */
  readonly remindOnReopen: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The largest page the API returns. A screen that receives exactly this many knows there may
 * be more and owes the reader either a "load more" or a plain warning — the inbox used to
 * show the oldest 200 silently, which read as "this is all of it".
 */
export const MAX_CLIENT_REQUEST_PAGE = 200;

export interface ListClientRequestsQuery {
  readonly projectId?: string;
  readonly clientOrganizationId?: string;
  readonly states?: readonly ClientRequestState[];
  /** The id cursor: rows after this id, in id (creation) order. */
  readonly after?: string;
  readonly limit?: number;
}

export async function listClientRequestRecords(
  client: ApiClient,
  organizationSlug: string,
  query: ListClientRequestsQuery = {},
): Promise<readonly ClientRequestRecord[]> {
  const parameters = new URLSearchParams();
  if (query.projectId) parameters.set('projectId', query.projectId);
  if (query.clientOrganizationId) {
    parameters.set('clientOrganizationId', query.clientOrganizationId);
  }
  if (query.states && query.states.length > 0) parameters.set('state', query.states.join(','));
  if (query.after) parameters.set('after', query.after);
  if (query.limit !== undefined) parameters.set('limit', String(query.limit));

  const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
  const { data } = await client.request<{ clientRequests: readonly ClientRequestRecord[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests${suffix}`,
  });
  return data.clientRequests;
}

export async function getClientRequestRecord(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
): Promise<ClientRequestRecord> {
  const { data } = await client.request<ClientRequestRecord>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}`,
  });
  return data;
}

/**
 * The three transitions that are not an acceptance.
 *
 * `accepted` is deliberately absent from the type. REQ-002 made acceptance a route of its own
 * because it creates the work in the same transaction, and the API refuses it here — so the type
 * says the same thing the server does rather than letting a caller find out at runtime.
 */
export type TriageMove =
  | { readonly to: 'triage' }
  | { readonly to: 'needs_clarification'; readonly clarificationQuestion: string }
  | { readonly to: 'deferred'; readonly clientVisibleReason: string }
  | { readonly to: 'declined'; readonly clientVisibleReason: string }
  | { readonly to: 'planned' }
  | { readonly to: 'delivered' };

export async function transitionClientRequest(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  version: number,
  move: TriageMove,
): Promise<ClientRequestRecord> {
  const { data } = await client.request<ClientRequestRecord>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/transitions`,
    body: { version, ...move },
  });
  return data;
}

export interface DeferClientRequestInput {
  readonly version: number;
  /** The reason the client reads. */
  readonly clientVisibleReason: string;
  /** `YYYY-MM-DD`: the day it comes back to triage. */
  readonly deferUntil: string;
  readonly remindOnReopen: boolean;
}

/** A7: "Defer until" — park the request until a day, optionally reminding the deferrer. */
export async function deferClientRequest(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  input: DeferClientRequestInput,
): Promise<ClientRequestRecord> {
  const { data } = await client.request<ClientRequestRecord>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/transitions`,
    body: { to: 'deferred', ...input },
  });
  return data;
}

/** A7: "Reopen now" — a deferred request back to triage before its date. */
export async function reopenClientRequest(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  version: number,
): Promise<ClientRequestRecord> {
  const { data } = await client.request<ClientRequestRecord>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/reopen`,
    body: { version },
  });
  return data;
}

export interface AcceptClientRequestBody {
  readonly version: number;
  readonly clientSafeScopeSummary: string;
  /** `"unscheduled"` or a `YYYY-MM-DD` date. Required — silence is not an answer to "when". */
  readonly commitment: string;
  /** Point at existing work. Mutually exclusive with `work`. */
  readonly linkedWorkItemId?: string;
  readonly work?: {
    readonly title?: string;
    readonly ownerUserId?: string;
    readonly audience?: 'internal' | 'client_visible' | 'client_action_required';
  };
  /** A7: "Tell <name> it is accepted". `false` keeps the client from being told. */
  readonly notifyClient?: boolean;
}

export interface AcceptedClientRequest {
  readonly request: ClientRequestRecord;
  readonly workItemId: string;
  readonly workItemCreated: boolean;
}

/**
 * Accept, and commit the work — REQ-002's one transaction.
 *
 * The response says whether the work was created here or merely linked, which is what the
 * confirmation screen tells the manager they have just done.
 */
export async function acceptClientRequest(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  body: AcceptClientRequestBody,
): Promise<AcceptedClientRequest> {
  const { data } = await client.request<AcceptedClientRequest>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/acceptance`,
    body,
  });
  return data;
}

export interface ClientRequestHistoryEntry {
  readonly id: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly result: string;
  readonly actorUserId: string | null;
  readonly createdAt: string;
}

export async function getClientRequestHistory(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
): Promise<readonly ClientRequestHistoryEntry[]> {
  const { data } = await client.request<{ history: readonly ClientRequestHistoryEntry[] }>({
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/history`,
  });
  return data.history;
}
