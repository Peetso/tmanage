import type { ApiClient } from './client';

/**
 * 56-06 · Blocked files (R44 L2) — the owner's queue of uploads the safety check refused.
 * Wraps `GET/POST /v1/organizations/:orgSlug/admin/file-safety/blocked` (`org.security.manage`).
 * {@link BlockedFileView} mirrors the API's `BlockedFileView` (`blocked-files.controller.ts`).
 */
export interface BlockedFileView {
  readonly id: string;
  readonly name: string;
  readonly extension: string;
  readonly detectedMimeType: string | null;
  readonly declaredMimeType: string | null;
  readonly sizeBytes: number | null;
  readonly reason: string;
  readonly uploadedBy: string | null;
  readonly blockedAt: string;
}

/** The reasons the screen names; any other code reads as "Other safety rule". */
export const BLOCK_REASONS = [
  'malware_detected',
  'type_not_allowed',
  'type_mismatch',
  'hash_mismatch',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number] | 'other';
export type BlockReasonFilter = BlockReason | 'all';

export function blockReason(code: string): BlockReason {
  return (BLOCK_REASONS as readonly string[]).includes(code) ? (code as BlockReason) : 'other';
}

/** The rows the active chip keeps. */
export function filterBlocked(
  files: readonly BlockedFileView[],
  filter: BlockReasonFilter,
): readonly BlockedFileView[] {
  return filter === 'all' ? files : files.filter((file) => blockReason(file.reason) === filter);
}

function base(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/admin/file-safety/blocked`;
}

export async function listBlockedFiles(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly BlockedFileView[]> {
  const { data } = await client.request<{ files: readonly BlockedFileView[] }>({
    path: base(organizationSlug),
  });
  return data.files;
}

/** Delete a blocked file's bytes now (204). */
export async function deleteBlockedFile(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `${base(organizationSlug)}/${encodeURIComponent(fileId)}/delete`,
  });
}
