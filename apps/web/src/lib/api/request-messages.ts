import type { ApiClient } from './client';

/**
 * The client <-> studio thread on a client request (BG3, `request-messages.controller.ts`).
 *
 * Two shapes, one per side of the boundary, for the same reason `client-requests.ts` and
 * `portal.ts` are separate modules: the team sees the internal record (author membership,
 * visibility flag); the client sees the projection (`from`, `mine`) and never an internal note.
 */

/** The team's view of one message. `clientVisible: false` is an internal note. */
export interface RequestMessageView {
  readonly id: string;
  readonly requestId: string;
  readonly authorMembershipId: string;
  readonly authorKind: 'internal' | 'client';
  readonly body: string;
  readonly clientVisible: boolean;
  readonly createdAt: string;
  /** A8: the author's display name; null when it no longer resolves. */
  readonly authorName: string | null;
  /** A8: files attached to the message. */
  readonly files: readonly { readonly id: string; readonly name: string }[];
}

/** The client's view of one message. Internal notes never reach this shape. */
export interface RequestMessageClientView {
  readonly id: string;
  readonly requestId: string;
  readonly from: 'studio' | 'client';
  readonly mine: boolean;
  readonly body: string;
  readonly createdAt: string;
  /** A8: who wrote it (the studio person or the client person). */
  readonly authorName: string | null;
  /** A8: files attached to the message. */
  readonly files: readonly { readonly id: string; readonly name: string }[];
}

/** A8: the most files one message carries (`MAX_REQUEST_MESSAGE_FILES`). */
export const MAX_REQUEST_MESSAGE_FILES = 10;

/** The API's limit on one message body (`MAX_REQUEST_MESSAGE_LENGTH`). */
export const MAX_REQUEST_MESSAGE_LENGTH = 5000;

function teamPath(organizationSlug: string, clientRequestId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/client-requests/${encodeURIComponent(clientRequestId)}/messages`;
}

function portalPath(organizationSlug: string, clientRequestId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/portal/requests/${encodeURIComponent(clientRequestId)}/messages`;
}

export async function listRequestMessages(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
): Promise<readonly RequestMessageView[]> {
  const { data } = await client.request<{ messages: readonly RequestMessageView[] }>({
    path: teamPath(organizationSlug, clientRequestId),
  });
  return data.messages;
}

export async function postRequestMessage(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  input: {
    readonly body: string;
    readonly clientVisible: boolean;
    readonly fileIds?: readonly string[];
  },
): Promise<RequestMessageView> {
  const { data } = await client.request<RequestMessageView>({
    method: 'POST',
    path: teamPath(organizationSlug, clientRequestId),
    body: {
      body: input.body,
      clientVisible: input.clientVisible,
      ...(input.fileIds && input.fileIds.length > 0 ? { fileIds: input.fileIds } : {}),
    },
  });
  return data;
}

export async function listPortalRequestMessages(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
): Promise<readonly RequestMessageClientView[]> {
  const { data } = await client.request<{ messages: readonly RequestMessageClientView[] }>({
    path: portalPath(organizationSlug, clientRequestId),
  });
  return data.messages;
}

export async function postPortalRequestMessage(
  client: ApiClient,
  organizationSlug: string,
  clientRequestId: string,
  input: { readonly body: string; readonly fileIds?: readonly string[] },
): Promise<RequestMessageClientView> {
  const { data } = await client.request<RequestMessageClientView>({
    method: 'POST',
    path: portalPath(organizationSlug, clientRequestId),
    body: {
      body: input.body,
      ...(input.fileIds && input.fileIds.length > 0 ? { fileIds: input.fileIds } : {}),
    },
  });
  return data;
}
