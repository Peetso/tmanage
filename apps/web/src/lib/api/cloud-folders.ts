import type { ApiClient } from './client';

/**
 * FIX6 C3 — live Google Drive / OneDrive folders on a work item, and the client's read of them in
 * the portal. The server reads the folder with the company connection; nothing here ever holds a
 * drive token or link. A child is opened through {@link openCloudFolderFile}: the server checks it
 * sits inside the attached folder and answers its checked TManage copy for the normal viewer.
 */

export type CloudFolderProvider = 'google_drive' | 'onedrive';

export interface CloudFolder {
  readonly id: string;
  readonly provider: CloudFolderProvider;
  readonly name: string;
  readonly createdAt: string;
}

export interface CloudFolderChild {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly modifiedTime: string | null;
  readonly isFolder: boolean;
}

export interface CloudFolderPage {
  readonly files: readonly CloudFolderChild[];
  readonly nextPageToken: string | null;
}

export type CloudFolderSource =
  | { readonly provider: 'google_drive'; readonly folderId: string }
  | { readonly provider: 'onedrive'; readonly driveId: string; readonly itemId: string };

/** `member` reads through the work item; `portal` through the client's own portal path. */
export type CloudFolderDoor = 'member' | 'portal';

function base(organizationSlug: string, workItemId: string, door: CloudFolderDoor): string {
  const org = `/v1/organizations/${encodeURIComponent(organizationSlug)}`;
  const item = `work-items/${encodeURIComponent(workItemId)}/cloud-folders`;
  return door === 'portal' ? `${org}/portal/${item}` : `${org}/${item}`;
}

export async function listCloudFolders(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  door: CloudFolderDoor,
): Promise<readonly CloudFolder[]> {
  const { data } = await client.request<{ readonly folders: readonly CloudFolder[] }>({
    path: `${base(organizationSlug, workItemId, door)}/`,
  });
  return data.folders;
}

export async function attachCloudFolder(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  source: CloudFolderSource,
): Promise<CloudFolder> {
  const { data } = await client.request<{ readonly folder: CloudFolder }>({
    method: 'POST',
    path: `${base(organizationSlug, workItemId, 'member')}/`,
    body: source,
  });
  return data.folder;
}

export async function removeCloudFolder(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  folderId: string,
): Promise<void> {
  await client.request<unknown>({
    method: 'DELETE',
    path: `${base(organizationSlug, workItemId, 'member')}/${encodeURIComponent(folderId)}`,
  });
}

export async function listCloudFolderChildren(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  folderId: string,
  door: CloudFolderDoor,
  input: { readonly parentId?: string; readonly pageToken?: string } = {},
): Promise<CloudFolderPage> {
  const query = new URLSearchParams();
  if (input.parentId) query.set('parentId', input.parentId);
  if (input.pageToken) query.set('pageToken', input.pageToken);
  const encoded = query.toString();
  const suffix = encoded === '' ? '' : `?${encoded}`;
  const { data } = await client.request<CloudFolderPage>({
    path: `${base(organizationSlug, workItemId, door)}/${encodeURIComponent(folderId)}/children${suffix}`,
  });
  return data;
}

/**
 * C3b. Open one child: the server checks it sits inside the folder, then makes (or reuses, while
 * the file is unchanged) its checked TManage copy. Answers the copy's id for the normal viewer.
 */
export async function openCloudFolderFile(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  folderId: string,
  childId: string,
  door: CloudFolderDoor,
): Promise<{ readonly fileId: string; readonly imported: boolean }> {
  const { data } = await client.request<{ readonly fileId: string; readonly imported: boolean }>({
    method: 'POST',
    path: `${base(organizationSlug, workItemId, door)}/${encodeURIComponent(folderId)}/items/${encodeURIComponent(childId)}/copy`,
  });
  return data;
}
