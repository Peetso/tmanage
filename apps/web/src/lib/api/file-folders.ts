import type { ApiClient } from './client';

/**
 * File folders (Files module, x332).
 *
 * This module wraps the file-folders API: list / create / delete named folders in a project, list a
 * folder's contents, and move a file into a folder (or back to root). Two response shapes are
 * exported and paired in the contracts gate — {@link FileFolder} (a folder, Exact with the API's
 * `FileFolderView`) and {@link FileFolderPlacement} (a file's folder, Exact with
 * `FileFolderPlacementView`). `organizationId` is absent on both, as on every wire projection.
 */

/** One folder — paired Exact with the API's `FileFolderView`. */
export interface FileFolder {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
}

/** A file's placement — its folder id, or `null` at root. Paired Exact with `FileFolderPlacementView`. */
export interface FileFolderPlacement {
  readonly fileId: string;
  readonly folderId: string | null;
}

/** FIX3 item 11 (FIL-01 Files hub). One ready file of a project — Exact with `ProjectFileView`. */
export interface ProjectFile {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly audience: string;
  readonly purpose: string;
  readonly versionNo: number | null;
  readonly updatedAt: string;
}

/** FIX3 item 11. A project's ready files, newest change first (internal members only). */
export async function listProjectFiles(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly ProjectFile[]> {
  const { data } = await client.request<{ files: readonly ProjectFile[] }>({
    path: `${orgBase(organizationSlug)}/projects/${encodeURIComponent(projectId)}/files`,
  });
  return data.files;
}

/** The fields a create sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface CreateFolderInput {
  readonly name: string;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/** List a project's folders, name-ascending. */
export async function listFileFolders(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
): Promise<readonly FileFolder[]> {
  const { data } = await client.request<{ folders: readonly FileFolder[] }>({
    path: `${orgBase(organizationSlug)}/projects/${encodeURIComponent(projectId)}/folders`,
  });
  return data.folders;
}

/** Create a folder in a project. */
export async function createFileFolder(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: CreateFolderInput,
): Promise<FileFolder> {
  const { data } = await client.request<FileFolder>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/projects/${encodeURIComponent(projectId)}/folders`,
    body: input,
  });
  return data;
}

/** Delete an empty folder. */
export async function deleteFileFolder(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  folderId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${orgBase(organizationSlug)}/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
  });
}

/** List the files filed into a folder. */
export async function listFolderContents(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  folderId: string,
): Promise<readonly FileFolderPlacement[]> {
  const { data } = await client.request<{ files: readonly FileFolderPlacement[] }>({
    path: `${orgBase(organizationSlug)}/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}/files`,
  });
  return data.files;
}

/** Move a file into a folder, or back to root (`folderId` null). Idempotent. */
export async function moveFileToFolder(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  folderId: string | null,
): Promise<FileFolderPlacement> {
  const { data } = await client.request<FileFolderPlacement>({
    method: 'PUT',
    path: `${orgBase(organizationSlug)}/files/${encodeURIComponent(fileId)}/folder`,
    body: { folderId },
  });
  return data;
}
