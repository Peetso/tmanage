import type { ApiClient } from './client';
import type { RootOwnerView } from './storage-root';
import type { StorageMode } from './google-drive';

/**
 * OneDrive as company storage (migration 0236) — the third card on Control > Storage, "Attach
 * from OneDrive" and uploads while OneDrive is the company's storage. Shapes mirror the API's
 * `OneDriveStatusView`, `OneDriveAttachmentView`, `OneDrivePickerSessionView` and
 * `OneDriveProjectFilesView` (`apps/api/src/modules/onedrive/onedrive.service.ts`).
 */

export type OneDriveConnectionStatus = 'not_connected' | 'connected' | 'error';

export interface OneDriveStatusView {
  readonly configured: boolean;
  readonly pickerAvailable: boolean;
  /** The company's one effective storage, across providers. */
  readonly storageMode: StorageMode | 'onedrive';
  readonly oneDrive: {
    readonly status: OneDriveConnectionStatus;
    readonly accountEmail: string | null;
    readonly folderPath: string | null;
    readonly driveName: string | null;
    readonly librariesEnabled: boolean;
    /** 51-17. Who owns the root and the hand-over state; null when not connected. */
    readonly rootOwner: RootOwnerView | null;
  };
}

export interface OneDriveAttachmentView {
  readonly id: string;
  readonly workItemId: string;
  readonly driveId: string;
  readonly itemId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly webUrl: string | null;
  readonly createdAt: string;
}

/**
 * NV10. `onedrive`: File Picker v8 with a resource token, for a caller who can read every project.
 * `scoped`: no token; the browser lists the project's own TManage folders.
 */
export type OneDrivePickerSessionView =
  | {
      readonly mode: 'onedrive';
      readonly accessToken: string;
      readonly accountType: 'personal' | 'business';
      readonly baseUrl: string;
      readonly rootDriveId: string;
      readonly rootItemId: string;
      readonly librariesEnabled: boolean;
    }
  | { readonly mode: 'scoped'; readonly projectId: string };

export interface OneDriveProjectFilesView {
  /** The drive every listed file lives in (the connection's root drive). */
  readonly driveId: string;
  readonly folderId: string | null;
  readonly files: readonly {
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
    readonly size: number | null;
    readonly modifiedTime: string | null;
    readonly isFolder: boolean;
  }[];
  readonly folders: readonly {
    readonly id: string;
    readonly kind: string;
    readonly name: string;
  }[];
  readonly nextPageToken: string | null;
}

export type OneDriveLocation =
  | { readonly kind: 'my_files' }
  | { readonly kind: 'folder'; readonly driveId: string; readonly itemId: string }
  | { readonly kind: 'library'; readonly driveId: string };

function storagePath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/integrations/onedrive`;
}

function itemPath(organizationSlug: string, workItemId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/onedrive`;
}

export async function getOneDriveStatus(
  client: ApiClient,
  organizationSlug: string,
): Promise<OneDriveStatusView> {
  const { data } = await client.request<OneDriveStatusView>({
    path: storagePath(organizationSlug),
  });
  return data;
}

/**
 * Start connecting; `libraries` also asks for SharePoint document libraries, and
 * `returnTo: 'connected-apps'` (R38) brings Microsoft's return to Connected apps, not Storage.
 */
export async function startOneDriveConnect(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly libraries?: boolean; readonly returnTo?: 'connected-apps' } = {},
): Promise<{ readonly url: string }> {
  const { data } = await client.request<{ url: string }>({
    method: 'POST',
    path: `${storagePath(organizationSlug)}/connect`,
    body: {
      ...(input.libraries ? { libraries: true } : {}),
      ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    },
  });
  return data;
}

export async function completeOneDriveConnect(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly code: string; readonly state: string },
): Promise<OneDriveStatusView> {
  const { data } = await client.request<OneDriveStatusView>({
    method: 'POST',
    path: `${storagePath(organizationSlug)}/complete`,
    body: input,
  });
  return data;
}

export async function updateOneDriveSettings(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly storageMode?: 'tmanage' | 'onedrive'; readonly location?: OneDriveLocation },
): Promise<OneDriveStatusView> {
  const { data } = await client.request<OneDriveStatusView>({
    method: 'PUT',
    path: `${storagePath(organizationSlug)}/settings`,
    body: input,
  });
  return data;
}

export async function disconnectOneDrive(
  client: ApiClient,
  organizationSlug: string,
): Promise<OneDriveStatusView> {
  const { data } = await client.request<OneDriveStatusView>({
    method: 'DELETE',
    path: storagePath(organizationSlug),
  });
  return data;
}

/**
 * How to choose OneDrive files. `resource` is the SharePoint origin a business picker asks a
 * token for; the API mints it only for the account's own origins.
 */
export async function getOneDrivePickerSession(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly projectId?: string; readonly resource?: string } = {},
): Promise<OneDrivePickerSessionView> {
  const search = new URLSearchParams();
  if (input.projectId) search.set('projectId', input.projectId);
  if (input.resource) search.set('resource', input.resource);
  const query = search.toString();
  const { data } = await client.request<OneDrivePickerSessionView>({
    path: `${storagePath(organizationSlug)}/picker-session${query ? `?${query}` : ''}`,
  });
  return data;
}

/** R36 F2. One folder of the connected drive for **Change folder**: its sub-folders only. */
export interface OneDriveFolderBrowseView {
  readonly driveId: string;
  readonly folder: { readonly id: string; readonly name: string; readonly isDriveRoot: boolean };
  readonly folders: readonly { readonly id: string; readonly name: string }[];
  readonly nextPageToken: string | null;
}

/** R36 F2. The sub-folders of `folderId` (the top of the connected drive by default). */
export async function browseOneDriveFolders(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly folderId?: string; readonly pageToken?: string } = {},
): Promise<OneDriveFolderBrowseView> {
  const search = new URLSearchParams();
  if (input.folderId) search.set('folderId', input.folderId);
  if (input.pageToken) search.set('pageToken', input.pageToken);
  const query = search.toString();
  const { data } = await client.request<OneDriveFolderBrowseView>({
    path: `${storagePath(organizationSlug)}/folders${query ? `?${query}` : ''}`,
  });
  return data;
}

/** NV10. One page of one of the project's own TManage folders (the project folder by default). */
export async function getProjectOneDriveFiles(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: { readonly folderId?: string; readonly pageToken?: string } = {},
): Promise<OneDriveProjectFilesView> {
  const search = new URLSearchParams();
  if (input.folderId) search.set('folderId', input.folderId);
  if (input.pageToken) search.set('pageToken', input.pageToken);
  const query = search.toString();
  const { data } = await client.request<OneDriveProjectFilesView>({
    path: `${storagePath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/files${query ? `?${query}` : ''}`,
  });
  return data;
}

export async function attachOneDriveFile(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: { readonly driveId: string; readonly itemId: string },
): Promise<OneDriveAttachmentView> {
  const { data } = await client.request<OneDriveAttachmentView>({
    method: 'POST',
    path: `${itemPath(organizationSlug, workItemId)}/attachments`,
    body: { driveId: input.driveId, itemId: input.itemId },
  });
  return data;
}

/**
 * FIX6 C1. Add the picked file to the work item as a checked TManage copy: the server fetches it
 * with the company connection and stores it like an upload, so a client can open it in the portal
 * with nothing connected. Answers the new file's id once it is attached.
 */
export async function importOneDriveFileToWorkItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  input: { readonly driveId: string; readonly itemId: string },
): Promise<string> {
  const { data } = await client.request<{ readonly file: { readonly id: string } }>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/onedrive-files`,
    body: { driveId: input.driveId, itemId: input.itemId },
  });
  return data.file.id;
}

export async function listOneDriveAttachments(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly OneDriveAttachmentView[]> {
  const { data } = await client.request<{ attachments: readonly OneDriveAttachmentView[] }>({
    path: `${itemPath(organizationSlug, workItemId)}/attachments`,
  });
  return data.attachments;
}

/**
 * Read the fragment the API's callback forwards to the Storage screen:
 * `#onedrive=complete&code&state` or `#onedrive=error`. Pure.
 */
export function readOneDriveReturn(
  hash: string,
): { readonly kind: 'complete'; code: string; state: string } | { readonly kind: 'error' } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const value = params.get('onedrive');
  if (value === 'error') return { kind: 'error' };
  const code = params.get('code');
  const state = params.get('state');
  if (value === 'complete' && code && state) return { kind: 'complete', code, state };
  return null;
}
