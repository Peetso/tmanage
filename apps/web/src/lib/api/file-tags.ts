import type { ApiClient } from './client';

/**
 * File tags (Files module, x270).
 *
 * This module wraps the file-tags API: list and define org-scoped tag definitions, and assign /
 * list / remove tags on a file asset. Two response shapes are exported and paired in the contracts
 * gate — {@link FileTag} (a definition, Exact with the API's `FileTagView`) and
 * {@link FileTagAssignment} (a tag on a file, Exact with `FileTagAssignmentView`). `organizationId`
 * is absent on both, as on every wire projection.
 */

/** One tag definition — paired Exact with the API's `FileTagView`. */
export interface FileTag {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** One tag assigned to a file — paired Exact with the API's `FileTagAssignmentView`. */
export interface FileTagAssignment {
  readonly id: string;
  readonly fileId: string;
  readonly tagId: string;
  readonly name: string;
  readonly createdAt: string;
}

/** The fields a define sends. Request-side (suffix `Input`), so the contracts gate ignores it. */
export interface DefineFileTagInput {
  readonly name: string;
}

function orgBase(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
}

/** List the organization's tag definitions, name-ascending. */
export async function listFileTags(
  client: ApiClient,
  organizationSlug: string,
): Promise<readonly FileTag[]> {
  const { data } = await client.request<{ tags: readonly FileTag[] }>({
    path: `${orgBase(organizationSlug)}/file-tags`,
  });
  return data.tags;
}

/** Define a tag. */
export async function defineFileTag(
  client: ApiClient,
  organizationSlug: string,
  input: DefineFileTagInput,
): Promise<FileTag> {
  const { data } = await client.request<FileTag>({
    method: 'POST',
    path: `${orgBase(organizationSlug)}/file-tags`,
    body: input,
  });
  return data;
}

/** List the tags assigned to a file. */
export async function listFileAssignments(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
): Promise<readonly FileTagAssignment[]> {
  const { data } = await client.request<{ tags: readonly FileTagAssignment[] }>({
    path: `${orgBase(organizationSlug)}/files/${encodeURIComponent(fileId)}/tags`,
  });
  return data.tags;
}

/** Tag a file (idempotent). */
export async function assignFileTag(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  tagId: string,
): Promise<FileTagAssignment> {
  const { data } = await client.request<FileTagAssignment>({
    method: 'PUT',
    path: `${orgBase(organizationSlug)}/files/${encodeURIComponent(fileId)}/tags/${encodeURIComponent(tagId)}`,
  });
  return data;
}

/** Untag a file. */
export async function removeFileTag(
  client: ApiClient,
  organizationSlug: string,
  fileId: string,
  tagId: string,
): Promise<void> {
  await client.request<void>({
    method: 'DELETE',
    path: `${orgBase(organizationSlug)}/files/${encodeURIComponent(fileId)}/tags/${encodeURIComponent(tagId)}`,
  });
}
