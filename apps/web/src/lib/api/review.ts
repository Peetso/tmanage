import type { ApiClient } from './client';

/**
 * R4 slice 5 — the proofing viewer's threads (studio): numbered pins, boxes, drawings, moments and
 * cells on a file, with their comments.
 *
 * - `GET  …/files/:fileId/review/threads?versionId=&status=` → {@link ReviewThreadList}
 * - `POST …/files/:fileId/review/threads` → {@link ReviewThread}
 * - `POST …/review/threads/:threadId/comments` → {@link ReviewComment}
 * - `POST …/review/threads/:threadId/resolve` · `…/unresolve` → {@link ReviewThread}
 * - `PATCH …/review/threads/:threadId` (move own pin) → {@link ReviewThread}
 * - `PATCH …/review/comments/:commentId` (edit own, 15 minutes) → {@link ReviewComment}
 * - `DELETE …/review/comments/:commentId` (own) → 204
 * - `GET  …/projects/:projectId/review/mention-candidates?q=&audience=` → {@link ReviewMentionCandidates}
 *
 * Anchors are numbers relative to the page or frame (0..1), never pixels, and never mirrored for
 * right-to-left screens: the stage converts them to its own box. Mirrors the API's views (paired
 * `Exact` in `e2e/contracts/api-web-shapes.ts`).
 */
export type ReviewSubjectType = 'file_asset' | 'figma_frame';
export type ReviewAnchorKind = 'pin' | 'box' | 'draw' | 'time' | 'cell' | 'none';
export type ReviewAudience = 'internal' | 'client_visible';
export type ReviewThreadStatus = 'open' | 'resolved';
export type ReviewPersonKind = 'internal' | 'client';

export interface ReviewPerson {
  readonly membershipId: string;
  /** `null` when the person is no longer a member. */
  readonly displayName: string | null;
  readonly kind: ReviewPersonKind;
}

export interface ReviewComment {
  readonly id: string;
  readonly threadId: string;
  readonly body: string;
  readonly mentions: readonly string[];
  readonly author: ReviewPerson;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export interface ReviewThread {
  readonly id: string;
  readonly number: number;
  readonly subjectType: ReviewSubjectType;
  readonly subjectId: string;
  readonly fileVersionId: string | null;
  readonly anchorKind: ReviewAnchorKind;
  readonly anchor: Readonly<Record<string, unknown>> | null;
  readonly pageNo: number | null;
  readonly timeMs: number | null;
  readonly audience: ReviewAudience;
  readonly status: ReviewThreadStatus;
  readonly createdBy: ReviewPerson;
  readonly createdAt: string;
  readonly resolvedBy: ReviewPerson | null;
  readonly resolvedAt: string | null;
  readonly carriedFromThreadId: string | null;
  readonly comments: readonly ReviewComment[];
  readonly canResolve: boolean;
  readonly canMove: boolean;
}

export interface ReviewThreadList {
  readonly threads: readonly ReviewThread[];
}

export interface ReviewMentionCandidate {
  readonly userId: string;
  readonly displayName: string;
  readonly kind: ReviewPersonKind;
  /** The token to insert in the text: `@<userId>`. */
  readonly mention: string;
}

export interface ReviewMentionCandidates {
  readonly candidates: readonly ReviewMentionCandidate[];
}

/** A pin {x,y}; a box {x,y,w,h}; a drawing {strokes}; a moment {timeMs,x?,y?}; a cell {sheet,cell}. */
export type ReviewAnchorInput =
  | { readonly x: number; readonly y: number }
  | { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  | {
      readonly strokes: readonly {
        readonly tool: 'pen' | 'arrow' | 'rect';
        readonly color: string;
        /** Line width in screen pixels (4 / 6 / 9 from the draw toolbar). */
        readonly width?: number;
        readonly points: readonly (readonly [number, number])[];
      }[];
    }
  | { readonly timeMs: number; readonly x?: number; readonly y?: number }
  | { readonly sheet: string; readonly cell: string };

export interface CreateReviewThreadInput {
  /** The uploaded version on screen (`manifest.version.fileVersionId`); a stale one is refused. */
  readonly versionId?: string;
  readonly anchorKind: ReviewAnchorKind;
  readonly anchor?: ReviewAnchorInput | null;
  readonly pageNo?: number | null;
  /** Staff only; omitted → internal, or client-visible when a client contact is mentioned. */
  readonly audience?: ReviewAudience;
  readonly body: string;
  readonly mentions?: readonly string[];
}

export interface ReviewCommentInput {
  readonly body: string;
  readonly mentions?: readonly string[];
}

export interface MoveReviewThreadInput {
  readonly versionId?: string;
  readonly anchor: ReviewAnchorInput | null;
  readonly pageNo?: number | null;
}

/**
 * Which door the viewer talks through: the studio's routes, or the client's twins under
 * `/portal` (R4 slice 8). The API keeps the rules per door; the paths are the only difference.
 */
export type ReviewDoor = 'studio' | 'portal';

function orgPath(organizationSlug: string, door: ReviewDoor = 'studio'): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}${door === 'portal' ? '/portal' : ''}`;
}

export async function listReviewThreads(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  options: { readonly versionId?: string; readonly status?: ReviewThreadStatus | 'all' } = {},
  door: ReviewDoor = 'studio',
): Promise<ReviewThreadList> {
  const params = new URLSearchParams();
  if (options.versionId) params.set('versionId', options.versionId);
  if (options.status) params.set('status', options.status);
  const query = params.toString() === '' ? '' : `?${params.toString()}`;
  const { data } = await client.request<ReviewThreadList>({
    path: `${orgPath(organizationSlug, door)}/files/${encodeURIComponent(fileId)}/review/threads${query}`,
  });
  return data;
}

export async function createReviewThread(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  input: CreateReviewThreadInput,
  door: ReviewDoor = 'studio',
): Promise<ReviewThread> {
  const { data } = await client.request<ReviewThread>({
    method: 'POST',
    path: `${orgPath(organizationSlug, door)}/files/${encodeURIComponent(fileId)}/review/threads`,
    body: input,
  });
  return data;
}

export async function replyToReviewThread(
  client: ApiClient,
  organizationSlug: string,
  threadId: string,
  input: ReviewCommentInput,
  door: ReviewDoor = 'studio',
): Promise<ReviewComment> {
  const { data } = await client.request<ReviewComment>({
    method: 'POST',
    path: `${orgPath(organizationSlug, door)}/review/threads/${encodeURIComponent(threadId)}/comments`,
    body: input,
  });
  return data;
}

export async function setReviewThreadResolved(
  client: ApiClient,
  organizationSlug: string,
  threadId: string,
  resolved: boolean,
  door: ReviewDoor = 'studio',
): Promise<ReviewThread> {
  const { data } = await client.request<ReviewThread>({
    method: 'POST',
    path: `${orgPath(organizationSlug, door)}/review/threads/${encodeURIComponent(threadId)}/${resolved ? 'resolve' : 'unresolve'}`,
  });
  return data;
}

export async function moveReviewThread(
  client: ApiClient,
  organizationSlug: string,
  threadId: string,
  input: MoveReviewThreadInput,
  door: ReviewDoor = 'studio',
): Promise<ReviewThread> {
  const { data } = await client.request<ReviewThread>({
    method: 'PATCH',
    path: `${orgPath(organizationSlug, door)}/review/threads/${encodeURIComponent(threadId)}`,
    body: input,
  });
  return data;
}

export async function editReviewComment(
  client: ApiClient,
  organizationSlug: string,
  commentId: string,
  input: ReviewCommentInput,
  door: ReviewDoor = 'studio',
): Promise<ReviewComment> {
  const { data } = await client.request<ReviewComment>({
    method: 'PATCH',
    path: `${orgPath(organizationSlug, door)}/review/comments/${encodeURIComponent(commentId)}`,
    body: input,
  });
  return data;
}

export async function deleteReviewComment(
  client: ApiClient,
  organizationSlug: string,
  commentId: string,
  door: ReviewDoor = 'studio',
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${orgPath(organizationSlug, door)}/review/comments/${encodeURIComponent(commentId)}`,
  });
}

export async function searchReviewMentionCandidates(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  options: {
    readonly q?: string;
    readonly audience?: ReviewAudience;
    readonly limit?: number;
  } = {},
  door: ReviewDoor = 'studio',
): Promise<ReviewMentionCandidates> {
  const params = new URLSearchParams();
  if (options.q) params.set('q', options.q);
  if (options.audience) params.set('audience', options.audience);
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString() === '' ? '' : `?${params.toString()}`;
  const { data } = await client.request<ReviewMentionCandidates>({
    path: `${orgPath(organizationSlug, door)}/projects/${encodeURIComponent(projectId)}/review/mention-candidates${query}`,
  });
  return data;
}

/** Open threads first, then by pin number — the order the thread panel lists them in. */
export function sortThreadsForPanel(threads: readonly ReviewThread[]): readonly ReviewThread[] {
  return threads
    .slice()
    .sort((a, b) => (a.status === b.status ? a.number - b.number : a.status === 'open' ? -1 : 1));
}
