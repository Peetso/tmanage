import type { ApiClient } from './client';

/**
 * C7 — a plain attachment's version history (`GET`/`POST …/files/:fileAssetId/versions`).
 * Version 1 is the attachment's own file; each later version is its own file asset, downloaded by
 * that asset's id through the ordinary download route, so the scan policy applies to every
 * version. Mirrors the API's `AttachmentVersionView` / `AttachmentHistoryView` (paired `Exact` in
 * `e2e/contracts`).
 */
export interface AttachmentVersion {
  readonly versionNo: number;
  readonly fileAssetId: string;
  readonly fileName: string;
  readonly availability: 'ready' | 'scanning' | 'unavailable';
  readonly note: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface AttachmentHistory {
  readonly rootFileAssetId: string;
  /** Newest first; always at least version 1. */
  readonly versions: readonly AttachmentVersion[];
}

/**
 * R4 slice 11 — what adding a version answers: the history and how many open comments travelled
 * from the version before (`AddedAttachmentVersionView`).
 */
export interface AddedAttachmentVersion extends AttachmentHistory {
  readonly carriedThreads: number;
}

function versionsPath(organizationSlug: string, fileAssetId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(fileAssetId)}/versions`;
}

export async function getAttachmentHistory(
  client: ApiClient,
  organizationSlug: string,
  fileAssetId: string,
): Promise<AttachmentHistory> {
  const { data } = await client.request<AttachmentHistory>({
    path: versionsPath(organizationSlug, fileAssetId),
  });
  return data;
}

/** Record an already-uploaded file as the newest version of the attachment. */
export async function addAttachmentVersion(
  client: ApiClient,
  organizationSlug: string,
  fileAssetId: string,
  input: {
    readonly fileAssetId: string;
    readonly note?: string | null;
    /** R4 slice 11. `open` (default): the open comments of the version before travel with it. */
    readonly carryForward?: 'open' | 'none';
    /** Only these open threads (the ticked list); every open one when omitted. */
    readonly carryThreadIds?: readonly string[];
  },
): Promise<AddedAttachmentVersion> {
  const { data } = await client.request<AddedAttachmentVersion>({
    method: 'POST',
    path: versionsPath(organizationSlug, fileAssetId),
    body: input,
  });
  return data;
}
