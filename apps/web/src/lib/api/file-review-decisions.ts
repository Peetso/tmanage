import type { ApiClient } from './client';
import type { ReviewDoor } from './review';

/**
 * R4 slice 11 — Approve / Request changes on the versions of a plain file, and each version's
 * review state for the Versions tab.
 *
 * - `GET  …/files/:fileId/review/decisions` → {@link FileReviewDecisions}
 * - `POST …/files/:fileId/review/decisions` `{fileAssetId?, decision, note?}` → {@link FileReviewDecisions}
 *
 * The portal twins live under `/portal`. A deliverable's file answers 409 (its decision goes
 * through the deliverable's approval). Mirrors the API's views (paired `Exact` in
 * `e2e/contracts/api-web-shapes.ts`).
 */
export type FileReviewDecision = 'approved' | 'changes_requested';
export type FileVersionReviewState = 'approved' | 'changes_requested' | 'in_review' | 'shared';

export interface FileReviewPerson {
  readonly membershipId: string;
  readonly displayName: string | null;
  readonly kind: 'internal' | 'client';
}

export interface FileReviewDecisionEntry {
  readonly id: string;
  readonly fileAssetId: string;
  readonly versionNo: number;
  readonly decision: FileReviewDecision;
  readonly note: string | null;
  readonly decidedBy: FileReviewPerson;
  readonly createdAt: string;
}

export interface FileVersionReview {
  readonly fileAssetId: string;
  readonly versionNo: number;
  readonly state: FileVersionReviewState;
  readonly openThreads: number;
  readonly resolvedThreads: number;
  readonly carriedThreads: number;
  readonly latestDecision: FileReviewDecisionEntry | null;
}

export interface FileReviewDecisions {
  readonly rootFileAssetId: string;
  /** Newest first. */
  readonly versions: readonly FileVersionReview[];
  /** Newest first. */
  readonly history: readonly FileReviewDecisionEntry[];
}

function decisionsPath(organizationSlug: string, fileId: string, door: ReviewDoor): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}${door === 'portal' ? '/portal' : ''}/files/${encodeURIComponent(fileId)}/review/decisions`;
}

export async function getFileReviewDecisions(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  door: ReviewDoor = 'studio',
): Promise<FileReviewDecisions> {
  const { data } = await client.request<FileReviewDecisions>({
    path: decisionsPath(organizationSlug, fileId, door),
  });
  return data;
}

export async function recordFileReviewDecision(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  input: {
    readonly fileAssetId?: string;
    readonly decision: FileReviewDecision;
    readonly note?: string | null;
  },
  door: ReviewDoor = 'studio',
): Promise<FileReviewDecisions> {
  const { data } = await client.request<FileReviewDecisions>({
    method: 'POST',
    path: decisionsPath(organizationSlug, fileId, door),
    body: input,
  });
  return data;
}

/** The StateCapsule state each review state is drawn with (Figma batch D mapping). */
export function capsuleStateFor(
  state: FileVersionReviewState,
): 'current' | 'done' | 'waiting' | 'client' {
  switch (state) {
    case 'approved':
      return 'done';
    case 'changes_requested':
      return 'waiting';
    case 'in_review':
      return 'current';
    default:
      return 'client';
  }
}
