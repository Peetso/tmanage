import type { ApiClient } from '../../../lib/api/client';
import type { RemoteCursor } from './collab-steps';

/**
 * Slice 53-10 — the co-editing endpoints (`…/documents/:id/collab`). The API answers 404 while
 * its `TMANAGE_DOC_COLLAB` switch is off; the editor then keeps its single-writer autosave.
 */

export interface CollabStepJson {
  readonly step: unknown;
  readonly clientId: string;
}

export interface CollabJoinResponse {
  readonly version: number;
  readonly baseVersion: number;
  readonly baseHtml: string | null;
  readonly steps: readonly CollabStepJson[];
  readonly colour: number;
  readonly role: 'editor' | 'viewer';
  readonly cursors: readonly (RemoteCursor & { readonly userId: string })[];
}

export type CollabPollResponse = (
  | { readonly kind: 'steps'; readonly version: number; readonly steps: readonly CollabStepJson[] }
  | { readonly kind: 'resync'; readonly version: number }
) & { readonly cursors: readonly (RemoteCursor & { readonly userId: string })[] };

function base(organizationSlug: string, documentId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/documents/${encodeURIComponent(documentId)}/collab`;
}

export async function joinCollab(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
): Promise<CollabJoinResponse> {
  const { data } = await client.request<CollabJoinResponse>({
    path: base(organizationSlug, documentId),
  });
  // Anything but a join (an older API, a proxy page) means co-editing is not available here.
  if (
    typeof data?.version !== 'number' ||
    typeof data.baseVersion !== 'number' ||
    !Array.isArray(data.steps) ||
    !Array.isArray(data.cursors) ||
    (data.role !== 'editor' && data.role !== 'viewer')
  ) {
    throw new Error('Live co-editing is not available');
  }
  return data;
}

export async function pollCollab(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  since: number,
): Promise<CollabPollResponse> {
  const { data } = await client.request<CollabPollResponse>({
    path: `${base(organizationSlug, documentId)}/steps?since=${since}`,
  });
  return data;
}

export async function pushCollabSteps(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  body: { readonly version: number; readonly clientId: string; readonly steps: unknown[] },
): Promise<{ readonly accepted: boolean; readonly version: number }> {
  const { data } = await client.request<{ readonly accepted: boolean; readonly version: number }>({
    method: 'POST',
    path: `${base(organizationSlug, documentId)}/steps`,
    body,
  });
  return data;
}

export async function snapshotCollab(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  body: { readonly version: number; readonly html: string },
): Promise<{ readonly saved: boolean; readonly version: number }> {
  const { data } = await client.request<{ readonly saved: boolean; readonly version: number }>({
    method: 'POST',
    path: `${base(organizationSlug, documentId)}/snapshot`,
    body,
  });
  return data;
}

export async function putCollabCursor(
  client: ApiClient,
  organizationSlug: string,
  documentId: string,
  body: { readonly clientId: string; readonly anchor: number; readonly head: number },
): Promise<void> {
  await client.request<unknown>({
    method: 'PUT',
    path: `${base(organizationSlug, documentId)}/cursor`,
    body,
  });
}
