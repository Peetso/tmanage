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
/**
 * `deliverable`: the deliverable itself (before or after any version). `file_asset`: an uploaded
 * `.fig` paired with its Figma file ("Show it from Figma").
 */
export type FigmaAttachTarget =
  'work_item' | 'deliverable' | 'deliverable_version' | 'request' | 'file_asset';
/** `skipped`: listed, beyond what the link captures (the file is over the limit, or a page left out). */
export type FigmaSnapshotStatus = 'pending' | 'ready' | 'failed' | 'skipped';
/** Why the last capture failed (team only). */
export type FigmaSnapshotError =
  | 'no_connection'
  | 'no_access'
  | 'not_found'
  | 'too_large'
  | 'unreachable'
  | 'timeout'
  | 'figma_error'
  | 'storage';

export interface FigmaConnection {
  readonly status: 'not_connected' | 'connected' | 'error';
  readonly handle: string | null;
  readonly tokenHint: string | null;
  /** FIX4 item 6: Figma's own sign-in is set up on this server, so Connect is one click. */
  readonly oneClick: boolean;
  /** PAUSED-FLAG: present on the status read while the platform has switched the service off. */
  readonly paused?: true;
}

export interface FigmaDetectedFrame {
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pageName: string | null;
  readonly sectionName: string | null;
}

export interface FigmaInspectPage {
  readonly id: string;
  readonly name: string;
  readonly frameCount: number;
}

export interface FigmaInspection {
  readonly fileName: string;
  readonly linkedNodeId: string | null;
  readonly pages: readonly FigmaInspectPage[];
  /** Every frame of the file, in Figma's order (for "Only some frames"). */
  readonly frames: readonly FigmaDetectedFrame[];
  readonly truncated: boolean;
  /** How many frames one link captures. */
  readonly maxFrames: number;
}

export interface FigmaFrame {
  readonly id: string;
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly pageId: string | null;
  readonly pageName: string | null;
  readonly sectionName: string | null;
  /** Where the frame sits on its page (the whole-page view), or null. */
  readonly x: number | null;
  readonly y: number | null;
  readonly snapshotStatus: FigmaSnapshotStatus;
  readonly snapshotPath: string | null;
  /** A small picture of the snapshot (the whole-page view), or null. */
  readonly thumbPath: string | null;
  /** A sharper render for zooming in, or null when the snapshot is already the sharpest. */
  readonly sharpPath: string | null;
  readonly sharpScale: number | null;
  readonly capturedAt: string | null;
  readonly sizeChanged: boolean;
  /** Removed in Figma at the last refresh; kept with its comments. */
  readonly gone: boolean;
  readonly openThreads: number;
  readonly embedUrl: string | null;
  readonly snapshotError: FigmaSnapshotError | null;
}

export interface FigmaLinkPage {
  readonly id: string;
  readonly name: string;
  readonly frameCount: number;
  readonly readyCount: number;
  readonly selected: boolean;
}

/** How much of the file there is, and how much is captured. */
export interface FigmaCapture {
  readonly mode: 'whole_file' | 'picked';
  readonly pageCount: number;
  readonly frameCount: number;
  readonly ready: number;
  readonly pending: number;
  readonly failed: number;
  readonly skipped: number;
  readonly gone: number;
  readonly maxFrames: number;
  readonly overLimit: boolean;
  readonly truncated: boolean;
  readonly syncedAt: string | null;
  /** Figma asked TManage to wait (429): pictures resume after this time. Team only. */
  readonly waitUntil: string | null;
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
  /** The frame the viewer opens on (the one the pasted link pointed at), or null. */
  readonly focusFrameId: string | null;
  readonly pages: readonly FigmaLinkPage[];
  readonly capture: FigmaCapture;
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
  /** "Only some frames"; left out, the whole file is attached. */
  readonly nodeIds?: readonly string[];
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

/** The client's door: every Figma link shared with this client (the portal's Files page). */
export async function listPortalFigmaLinks(
  client: ApiClient,
  organizationSlug: string,
): Promise<FigmaLinkList> {
  const { data } = await client.request<FigmaLinkList>({
    path: `${orgPath(organizationSlug, 'portal')}/figma/links`,
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

/** Which pages to capture when the file is over the limit (`null`: every page). */
export async function setFigmaPages(
  client: ApiClient,
  organizationSlug: string,
  linkId: string,
  pageIds: readonly string[] | null,
): Promise<FigmaLink> {
  const { data } = await client.request<FigmaLink>({
    method: 'PUT',
    path: `${orgPath(organizationSlug)}/figma/links/${encodeURIComponent(linkId)}/pages`,
    body: { pageIds },
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

/**
 * A frame picture's address on the API (`snapshotPath`, `thumbPath` and `sharpPath` are relative
 * to the organization).
 */
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

export type FigmaProblem =
  'not_connected' | 'no_access' | 'rate_limited' | 'recently_refreshed' | 'unreachable';

/** Which Figma refusal an API error is (`409` with the `figma` detail), or null for any other. */
export function figmaProblem(error: unknown): FigmaProblem | null {
  if (!(error instanceof ApiRequestError) || error.status !== 409) return null;
  const detail = error.details.find((item) => item.field === 'figma')?.message;
  return detail === 'not_connected' ||
    detail === 'no_access' ||
    detail === 'rate_limited' ||
    detail === 'recently_refreshed' ||
    detail === 'unreachable'
    ? detail
    : null;
}

/** For a Figma refusal: in how many seconds asking again makes sense, or null when not said. */
export function figmaRetryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof ApiRequestError)) return null;
  const raw = error.details.find((item) => item.field === 'retry_after')?.message;
  const seconds = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
