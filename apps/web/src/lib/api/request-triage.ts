import type { ApiClient } from './client';

/**
 * The request-triage endpoints — module 11 (x265), the studio's internal triage of an incoming client
 * request (category + optional assignee). Behind `client_request.triage` on the server (the internal-
 * only capability the requests module already uses); a caller without it gets the 403 the shared
 * client turns into an error, an off-allowlist category gets a 400, and a request that is not the
 * caller's studio gets a 404.
 *
 * Hand-written for the boundary reason `errors.ts` gives, and paired with the API projection in the
 * `e2e/contracts` shape check so the two shapes cannot drift. The tenant is the slug in the path
 * resolved against the caller's membership, never a value the caller supplies.
 */

/** A request's triage. `category` and `assigneeMembershipId` are `null` until the request is triaged. */
export interface RequestTriageView {
  readonly requestId: string;
  readonly category: string | null;
  readonly assigneeMembershipId: string | null;
  readonly triaged: boolean;
}

/** The body the triage panel sends: the chosen category and, optionally, the assignee. */
export interface RequestTriageInput {
  readonly category: string;
  readonly assigneeMembershipId?: string | null;
}

function triagePath(organizationSlug: string, clientRequestId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(
    clientRequestId,
  )}/triage`;
}

export async function fetchRequestTriage(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
): Promise<RequestTriageView> {
  const { data } = await client.request<RequestTriageView>({
    path: triagePath(organizationSlug, clientRequestId),
  });
  return data;
}

export async function putRequestTriage(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  input: RequestTriageInput,
): Promise<RequestTriageView> {
  const { data } = await client.request<RequestTriageView>({
    method: 'PUT',
    path: triagePath(organizationSlug, clientRequestId),
    body: input,
  });
  return data;
}
