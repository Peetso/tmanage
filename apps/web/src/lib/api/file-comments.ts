import type { ApiClient } from './client';

/**
 * File comments (Files module, x333).
 *
 * This module wraps the file-comments API: list a file's comments oldest-first, add one, and delete
 * your own. The response shape {@link FileComment} is exported and paired Exact with the API's
 * `FileCommentView` in the contracts gate (`e2e/contracts/api-web-shapes.ts`). `organizationId` is
 * absent, as on every wire projection. A file the caller may not read is a 404, the same 404 an
 * unknown or cross-tenant id answers — the API resolves the id tenant-scoped before the relation
 * check — so the view never has to tell the cases apart.
 */

/** One file comment — paired Exact with the API's `FileCommentView`. */
export interface FileComment {
  readonly id: string;
  readonly fileId: string;
  readonly body: string;
  /** The membership that authored the comment; the "delete own" control compares it to the viewer. */
  readonly createdBy: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

function base(organizationSlug: string, fileId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/files/${encodeURIComponent(fileId)}/comments`;
}

/** List a file's comments, oldest first. */
export async function listFileComments(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
): Promise<readonly FileComment[]> {
  const { data } = await client.request<{ comments: readonly FileComment[] }>({
    path: base(organizationSlug, fileId),
  });
  return data.comments;
}

/** Comment on a file. */
export async function addFileComment(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  body: string,
): Promise<FileComment> {
  const { data } = await client.request<FileComment>({
    method: 'POST',
    path: base(organizationSlug, fileId),
    body: { body },
  });
  return data;
}

/** Delete your own comment on a file. */
export async function removeFileComment(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  commentId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${base(organizationSlug, fileId)}/${encodeURIComponent(commentId)}`,
  });
}
