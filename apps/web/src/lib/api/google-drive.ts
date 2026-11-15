import type { ApiClient } from './client';

/**
 * Google Drive as company storage (migration 0210) — the Control > Storage screen and "Attach from
 * Google Drive" on New work. Shapes mirror the API's `StorageStatusView`, `DriveAttachmentView` and
 * `PickerSessionView` (`apps/api/src/modules/google-drive/google-drive.service.ts`).
 */

export type StorageMode = 'tmanage' | 'google_drive';
export type DriveConnectionStatus = 'not_connected' | 'connected' | 'error';

export interface StorageStatusView {
  readonly configured: boolean;
  readonly pickerAvailable: boolean;
  /** 0236. The company's one storage across providers; OneDrive is the API's second option. */
  readonly storageMode: StorageMode | 'onedrive';
  readonly googleDrive: {
    readonly status: DriveConnectionStatus;
    readonly accountEmail: string | null;
    readonly folderPath: string | null;
    readonly sharedDriveName: string | null;
  };
}

export interface DriveAttachmentView {
  readonly id: string;
  readonly workItemId: string;
  readonly driveFileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly webViewLink: string | null;
  readonly createdAt: string;
}

/**
 * NV10. `google`: Google's own picker with a short-lived token, for a caller who can read every
 * project. `scoped`: no token; the browser lists the project's own TManage folders through
 * {@link getProjectDriveFiles}.
 */
export type PickerSessionView =
  | {
      readonly mode: 'google';
      readonly accessToken: string;
      readonly apiKey: string;
      readonly appId: string | null;
      readonly rootFolderId: string | null;
    }
  | { readonly mode: 'scoped'; readonly projectId: string };

export interface ProjectDriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly modifiedTime: string | null;
  readonly isFolder: boolean;
}

export interface ProjectDriveFolder {
  readonly id: string;
  readonly kind: 'project' | 'work_item';
  readonly name: string;
}

export interface ProjectDriveFilesView {
  /** The folder listed (the project folder by default); null when the project has none yet. */
  readonly folderId: string | null;
  readonly files: readonly ProjectDriveFile[];
  readonly folders: readonly ProjectDriveFolder[];
  readonly nextPageToken: string | null;
}

export type DriveLocation =
  { readonly kind: 'my_drive' } | { readonly kind: 'folder'; folderId: string };

function storagePath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/integrations/google-drive`;
}

function itemPath(organizationSlug: string, workItemId: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/google-drive`;
}

export async function getStorageStatus(
  client: ApiClient,
  organizationSlug: string,
): Promise<StorageStatusView> {
  const { data } = await client.request<StorageStatusView>({ path: storagePath(organizationSlug) });
  return data;
}

/**
 * Start connecting; the browser then goes to Google's consent screen at `url`. With
 * `returnTo: 'connected-apps'` (R38) Google's return lands on Connected apps, not Storage.
 */
export async function startDriveConnect(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly returnTo?: 'connected-apps' } = {},
): Promise<{ readonly url: string }> {
  const { data } = await client.request<{ url: string }>({
    method: 'POST',
    path: `${storagePath(organizationSlug)}/connect`,
    body: input.returnTo ? { returnTo: input.returnTo } : {},
  });
  return data;
}

export async function completeDriveConnect(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly code: string; readonly state: string },
): Promise<StorageStatusView> {
  const { data } = await client.request<StorageStatusView>({
    method: 'POST',
    path: `${storagePath(organizationSlug)}/complete`,
    body: input,
  });
  return data;
}

export async function updateStorageSettings(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly storageMode?: StorageMode; readonly location?: DriveLocation },
): Promise<StorageStatusView> {
  const { data } = await client.request<StorageStatusView>({
    method: 'PUT',
    path: `${storagePath(organizationSlug)}/settings`,
    body: input,
  });
  return data;
}

export async function disconnectDrive(
  client: ApiClient,
  organizationSlug: string,
): Promise<StorageStatusView> {
  const { data } = await client.request<StorageStatusView>({
    method: 'DELETE',
    path: storagePath(organizationSlug),
  });
  return data;
}

/**
 * How to choose Drive files. Without `projectId` only the company owner gets a picker token (the
 * Storage screen); with one, an org-wide caller gets the Google picker and a project-scoped member
 * gets `scoped`, with no token (NV10).
 */
export async function getPickerSession(
  client: ApiClient,
  organizationSlug: string,
  projectId?: string,
): Promise<PickerSessionView> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const { data } = await client.request<PickerSessionView>({
    path: `${storagePath(organizationSlug)}/picker-session${query}`,
  });
  return data;
}

/** NV10. One page of one of the project's own TManage folders (the project folder by default). */
export async function getProjectDriveFiles(
  client: ApiClient,
  organizationSlug: string,
  projectId: string,
  input: { readonly folderId?: string; readonly pageToken?: string } = {},
): Promise<ProjectDriveFilesView> {
  const search = new URLSearchParams();
  if (input.folderId) search.set('folderId', input.folderId);
  if (input.pageToken) search.set('pageToken', input.pageToken);
  const query = search.toString();
  const { data } = await client.request<ProjectDriveFilesView>({
    path: `${storagePath(organizationSlug)}/projects/${encodeURIComponent(projectId)}/files${query ? `?${query}` : ''}`,
  });
  return data;
}

export async function attachDriveFile(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  driveFileId: string,
): Promise<DriveAttachmentView> {
  const { data } = await client.request<DriveAttachmentView>({
    method: 'POST',
    path: `${itemPath(organizationSlug, workItemId)}/attachments`,
    body: { driveFileId },
  });
  return data;
}

/**
 * FIX6 C1. Add the picked file to the work item as a checked TManage copy: the server fetches it
 * with the company connection and stores it like an upload, so a client can open it in the portal
 * with nothing connected. Answers the new file's id once it is attached.
 */
export async function importDriveFileToWorkItem(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
  fileId: string,
): Promise<string> {
  const { data } = await client.request<{ readonly file: { readonly id: string } }>({
    method: 'POST',
    path: `/v1/organizations/${encodeURIComponent(organizationSlug)}/work-items/${encodeURIComponent(workItemId)}/drive-files`,
    body: { fileId },
  });
  return data.file.id;
}

export async function listDriveAttachments(
  client: ApiClient,
  organizationSlug: string,
  workItemId: string,
): Promise<readonly DriveAttachmentView[]> {
  const { data } = await client.request<{ attachments: readonly DriveAttachmentView[] }>({
    path: `${itemPath(organizationSlug, workItemId)}/attachments`,
  });
  return data.attachments;
}

/**
 * Read the fragment the API's callback forwards to the Storage screen: `#drive=complete&code&state`
 * or `#drive=error`. Pure, so the hand-over is provable without a browser.
 */
export function readDriveReturn(
  hash: string,
): { readonly kind: 'complete'; code: string; state: string } | { readonly kind: 'error' } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const drive = params.get('drive');
  if (drive === 'error') return { kind: 'error' };
  const code = params.get('code');
  const state = params.get('state');
  if (drive === 'complete' && code && state) return { kind: 'complete', code, state };
  return null;
}
