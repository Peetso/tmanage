import type { ApiClient } from './client';
import { ApiRequestError } from './errors';
import type {
  CreateReviewThreadInput,
  ReviewDoor,
  ReviewThread,
  ReviewThreadList,
  ReviewThreadStatus,
} from './review';

/**
 * R4 slice 13 — Figma links in the proofing viewer: the member's own Figma connection, attaching
 * frames of a Figma file to a project (or one work item / deliverable version / request), the
 * viewer's manifest, "Refresh snapshots", and the threads on frames. Types mirror the API's views
 * exactly (paired in `e2e/contracts/api-web-shapes.ts`).
 */

export type FigmaLinkAudience = 'internal' | 'client_visible';
export type FigmaAttachTarget = 'work_item' | 'deliverable_version' | 'request';
export type FigmaSnapshotStatus = 'pending' | 'ready' | 'failed';

export interface FigmaConnection {
  readonly status: 'not_connected' | 'connected' | 'error';
  readonly handle: string | null;
  readonly tokenHint: string | null;
  /** FIX4 item 6: Figma's own sign-in is set up on this server, so Connect is one click. */
  readonly oneClick: boolean;
}

export interface FigmaDetectedFrame {
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pageName: string | null;
}

export interface FigmaInspection {
  readonly fileName: string;
  readonly linkedNodeId: string | null;
  readonly frames: readonly FigmaDetectedFrame[];
  readonly maxFrames: number;
}

export interface FigmaFrame {
  readonly id: string;
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly snapshotStatus: FigmaSnapshotStatus;
  readonly snapshotPath: string | null;
  readonly capturedAt: string | null;
  readonly sizeChanged: boolean;
  readonly openThreads: number;
  readonly embedUrl: string | null;
}

export interface FigmaLinkCapabilities {
  readonly canComment: boolean;
  readonly canRefresh: boolean;
  readonly canRemove: boolean;
  readonly canLive: boolean;
}

export interface FigmaLink {
  readonly id: string;
  readonly projectId: string;
  readonly fileName: string | null;
  readonly audience: FigmaLinkAudience;
  readonly attachedToType: FigmaAttachTarget | null;
  readonly attachedToId: string | null;
  readonly openUrl: string | null;
  readonly createdAt: string;
  readonly frames: readonly FigmaFrame[];
  readonly capabilities: FigmaLinkCapabilities;
}

export interface FigmaLinkSummary {
  readonly id: string;
  readonly fileName: string | null;
  readonly audience: FigmaLinkAudience;
  readonly frameCount: number;
  readonly createdAt: string;
}

export interface FigmaLinkList {
  readonly links: readonly FigmaLinkSummary[];
}

export interface FigmaRefresh {
  readonly queued: number;
}

export interface AttachFigmaInput {
  readonly url: string;
  readonly nodeIds: readonly string[];
  readonly audience: FigmaLinkAudience;
  readonly attachedTo?: { readonly type: FigmaAttachTarget; readonly id: string } | null;
}

function orgPath(organizationSlug: string, door: ReviewDoor = 'studio'): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}${door === 'portal' ? '/portal' : ''}`;
}

export async function getFigmaConnection(
  client: ApiClient,
  organizationSlug: string,
): Promise<FigmaConnection> {
  const { data } = await client.request<FigmaConnection>({
    path: `${orgPath(organizationSlug)}/figma/connection`,
  });
  return data;
}

export async function connectFigma(
  client: ApiClient,
  organizationSlug: string,
  token: string,
): Promise<FigmaConnection> {
  const { data } = await client.request<FigmaConnection>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/figma/connection`,
    body: { token },
  });
  return data;
}

/** FIX4 item 6. One-click Connect: Figma's consent address (the browser goes there next). */
export async function startFigmaConnect(
  client: ApiClient,
  organizationSlug: string,
  returnTo: 'integrations' | 'connected-apps' = 'integrations',
): Promise<{ readonly url: string }> {
  const { data } = await client.request<{ readonly url: string }>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/figma/connection/start`,
    body: { returnTo },
  });
  return data;
}

/** FIX4 item 6. Finish one-click Connect with what Figma sent back. */
export async function completeFigmaConnect(
  client: ApiClient,
  organizationSlug: string,
  body: { readonly code: string; readonly state: string },
): Promise<FigmaConnection> {
  const { data } = await client.request<FigmaConnection>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/figma/connection/complete`,
    body,
  });
  return data;
}

/** FIX4 item 6. Figma's return to Integrations (`#figma=complete&code=…&state=…`), if any. */
export function readFigmaReturn(
  hash: string,
):
  | { readonly kind: 'complete'; readonly code: string; readonly state: string }
  | { readonly kind: 'error' }
  | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const kind = params.get('figma');
  if (kind === 'error') return { kind: 'error' };
  if (kind !== 'complete') return null;
  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';
  return code !== '' && state !== '' ? { kind: 'complete', code, state } : { kind: 'error' };
}

export async function disconnectFigma(
  client: ApiClient,
  organizationSlug: string,
): Promise<FigmaConnection> {
  const { data } = await client.request<FigmaConnection>({
    method: 'DELETE',
    path: `${orgPath(organizationSlug)}/figma/connection`,
  });
  return data;
}

export async function inspectFigmaUrl(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  url: string,
): Promise<FigmaInspection> {
  const { data } = await client.request<FigmaInspection>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/figma/inspect`,
    body: { url },
  });
  return data;
}

export async function attachFigmaLink(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: AttachFigmaInput,
): Promise<FigmaLink> {
  const { data } = await client.request<FigmaLink>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/figma/links`,
    body: input,
  });
  return data;
}

export async function listFigmaLinks(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  target: { readonly type: FigmaAttachTarget; readonly id: string } | null = null,
  door: ReviewDoor = 'studio',
): Promise<FigmaLinkList> {
  const query = target
    ? `?attachedToType=${encodeURIComponent(target.type)}&attachedToId=${encodeURIComponent(target.id)}`
    : '';
  const { data } = await client.request<FigmaLinkList>({
    path: `${orgPath(organizationSlug, door)}/projects/${encodeURIComponent(projectId)}/figma/links${query}`,
  });
  return data;
}

export async function getFigmaLink(
  client: ApiClient,
  organizationSlug: string,
  linkId: string,
  door: ReviewDoor = 'studio',
): Promise<FigmaLink> {
  const { data } = await client.request<FigmaLink>({
    path: `${orgPath(organizationSlug, door)}/figma/links/${encodeURIComponent(linkId)}`,
  });
  return data;
}

export async function refreshFigmaSnapshots(
  client: ApiClient,
  organizationSlug: string,
  linkId: string,
): Promise<FigmaRefresh> {
  const { data } = await client.request<FigmaRefresh>({
    method: 'POST',
    path: `${orgPath(organizationSlug)}/figma/links/${encodeURIComponent(linkId)}/snapshots`,
  });
  return data;
}

export async function removeFigmaLink(
  client: ApiClient,
  organizationSlug: string,
  linkId: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${orgPath(organizationSlug)}/figma/links/${encodeURIComponent(linkId)}`,
  });
}

/** The snapshot's address on the API (`snapshotPath` is relative to the organization). */
export function figmaSnapshotUrl(
  apiBase: string,
  organizationSlug: string,
  snapshotPath: string,
): string {
  return `${apiBase}/v1/organizations/${encodeURIComponent(organizationSlug)}${snapshotPath}`;
}

export async function listFigmaFrameThreads(
  client: ApiClient,
  organizationSlug: string,
  frameId: string,
  options: { readonly status?: ReviewThreadStatus | 'all' } = {},
  door: ReviewDoor = 'studio',
): Promise<ReviewThreadList> {
  const query = options.status ? `?status=${encodeURIComponent(options.status)}` : '';
  const { data } = await client.request<ReviewThreadList>({
    path: `${orgPath(organizationSlug, door)}/figma/frames/${encodeURIComponent(frameId)}/review/threads${query}`,
  });
  return data;
}

export async function createFigmaFrameThread(
  client: ApiClient,
  organizationSlug: string,
  frameId: string,
  input: Omit<CreateReviewThreadInput, 'versionId' | 'pageNo'>,
  door: ReviewDoor = 'studio',
): Promise<ReviewThread> {
  const { data } = await client.request<ReviewThread>({
    method: 'POST',
    path: `${orgPath(organizationSlug, door)}/figma/frames/${encodeURIComponent(frameId)}/review/threads`,
    body: input,
  });
  return data;
}

export type FigmaProblem = 'not_connected' | 'no_access' | 'rate_limited' | 'unreachable';

/** Which Figma refusal an API error is (`409` with the `figma` detail), or null for any other. */
export function figmaProblem(error: unknown): FigmaProblem | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const detail = error.details.find((item) => item.field === 'figma')?.message;
  return detail === 'not_connected' ||
    detail === 'no_access' ||
    detail === 'rate_limited' ||
    detail === 'unreachable'
    ? detail
    : null;
}
