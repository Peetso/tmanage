import type { ApiClient } from './client';

/**
 * DOC subscriptions (x312) — a member's explicit follow list over documents. Read the caller's follow
 * status of one document, subscribe/unsubscribe, and list the caller's subscriptions. All are behind the
 * `doc.read` capability the API enforces (a member follows a document they may read); this module wraps
 * only what the subscription toggle and the my-subscriptions view consume, the discipline the contracts
 * gate enforces on this folder.
 */

/**
 * One of the caller's followed documents — paired Exact with the API's `DocSubscriptionView` in the
 * contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId`/`membershipId` are absent on both
 * sides: the wire projection never echoes the tenant id, and the membership is always the caller's own.
 */
export interface DocSubscriptionSummary {
  readonly id: string;
  readonly documentId: string;
  readonly title: string;
  readonly projectId: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function docBase(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/subscription`;
}

function listBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/me/doc-subscriptions`;
}

/** Whether the caller is subscribed to a document. */
export async function getDocSubscriptionStatus(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<boolean> {
  const { data } = await client.request<{ subscribed: boolean }>({
    path: docBase(organizationSlug, documentId),
  });
  return data.subscribed;
}

/** Subscribe the caller to a document. Idempotent: a repeated call returns the same summary. */
export async function addDocSubscription(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<DocSubscriptionSummary> {
  const { data } = await client.request<DocSubscriptionSummary>({
    method: 'PUT',
    path: docBase(organizationSlug, documentId),
  });
  return data;
}

/** Unsubscribe the caller from a document. Idempotent: no subscription is still success. */
export async function removeDocSubscription(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: docBase(organizationSlug, documentId),
  });
}

/** List the caller's subscriptions, newest first. */
export async function listDocSubscriptions(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly DocSubscriptionSummary[]> {
  const { data } = await client.request<{ subscriptions: readonly DocSubscriptionSummary[] }>({
    path: listBase(organizationSlug),
  });
  return data.subscriptions;
}
