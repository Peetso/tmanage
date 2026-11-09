import type { ApiClient } from './client';

/**
 * FIX5 item 5 (live bug B-N5) — delete an uploaded file, and undo it.
 *
 * - `DELETE …/files/:fileId` → 204. A soft delete with the platform's restore window: the file
 *   leaves Files, the messages and work items it was attached to, and its viewer. Idempotent.
 * - `POST …/files/:fileId/restore` → 204. Brings it back while the window is open. Idempotent.
 *
 * Only the uploader, a manager of the file's project or the company owner/admin may (403
 * otherwise); the Files hub row and the viewer manifest carry `canDelete` so a screen offers the
 * action only to them.
 */

function filePath(organizationSlug: string, fileId: string): string {
  return (
    `/v1/organizations/${encodeURIComponent(organizationSlug)}` +
    `/files/${encodeURIComponent(fileId)}`
  );
}

export async function deleteFile(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
): Promise<void> {
  await client.request<void>({ method: 'DELETE', path: filePath(organizationSlug, fileId) });
}

export async function restoreFile(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
): Promise<void> {
  await client.request<void>({
    method: 'POST',
    path: `${filePath(organizationSlug, fileId)}/restore`,
  });
}
