import type { ApiClient } from './client';

/**
 * 51-17 (0356). Who owns the company storage root, and handing the connection to another admin.
 * Shapes mirror the API's `RootOwnerView` (`apps/api/src/modules/storage-root/root-owner.ts`) and
 * `StorageHandoverTargetView` / `StorageHandoverView` (`storage-handover.service.ts`).
 */

export type RootOwnerKind = 'shared_drive' | 'sharepoint_library' | 'personal' | 'unknown';
export type StorageProvider = 'google_drive' | 'onedrive';

export interface RootOwnerView {
  readonly kind: RootOwnerKind;
  readonly companyOwned: boolean;
  readonly recommendCompanyRoot: boolean;
  readonly connectedByMe: boolean;
  readonly handover: 'none' | 'pending' | 'pending_for_me';
}

export interface StorageHandoverTargetView {
  readonly userId: string;
  readonly displayName: string;
}

export interface StorageHandoverView {
  readonly provider: StorageProvider;
  readonly toUserId: string;
  readonly toDisplayName: string;
  readonly status: 'pending';
}

/**
 * 51-17 slice 2. `GET …/integrations/google-drive/root-options` (Shared Drives) and
 * `…/onedrive/root-options` (SharePoint libraries): the company-owned places the connected
 * account can hold the root. Mirrors the API's `CompanyRootOptionsView` (`root-owner.ts`).
 */
export interface CompanyRootOptionsView {
  readonly kind: 'shared_drive' | 'sharepoint_library';
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

function basePath(organizationSlug: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/integrations/storage`;
}

export async function listHandoverTargets(
  client: ApiClient,
  organizationSlug: string,
  provider: StorageProvider,
): Promise<readonly StorageHandoverTargetView[]> {
  const { data } = await client.request<{ targets: StorageHandoverTargetView[] }>({
    path: `${basePath(organizationSlug)}/handover-targets?provider=${provider}`,
  });
  return data.targets;
}

export async function requestStorageHandover(
  client: ApiClient,
  organizationSlug: string,
  input: { readonly provider: StorageProvider; readonly toUserId: string },
): Promise<StorageHandoverView> {
  const { data } = await client.request<StorageHandoverView>({
    method: 'POST',
    path: `${basePath(organizationSlug)}/handover`,
    body: input,
  });
  return data;
}

/**
 * 57-13b. "Move to Drive": the job that moves the files TManage still holds into the connected
 * provider. Mirrors the API's `StorageMoveView` (`storage-root/storage-move.service.ts`). The
 * request names only the provider; the destination folder and the files are chosen by the server.
 */
export type StorageMoveStatus = 'queued' | 'running' | 'done' | 'stopped';

export interface StorageMoveView {
  readonly id: string;
  readonly provider: StorageProvider;
  readonly status: StorageMoveStatus;
  readonly total: number;
  readonly moved: number;
  readonly failed: number;
  readonly skipped: number;
  readonly movedBytes: number;
  /** Why a job stopped (`not_connected`, `provider_unavailable`, `connection_changed`), else null. */
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export async function startStorageMove(
  client: ApiClient,
  organizationSlug: string,
  provider: StorageProvider,
): Promise<StorageMoveView> {
  const { data } = await client.request<StorageMoveView>({
    method: 'POST',
    path: `${basePath(organizationSlug)}/migration-jobs`,
    body: { provider },
  });
  return data;
}

/** The company's latest job (or null), for the storage card after a reload. */
export async function getLatestStorageMove(
  client: ApiClient,
  organizationSlug: string,
): Promise<StorageMoveView | null> {
  const { data } = await client.request<{ job: StorageMoveView | null }>({
    path: `${basePath(organizationSlug)}/migration-jobs`,
  });
  return data.job;
}

export async function getStorageMove(
  client: ApiClient,
  organizationSlug: string,
  jobId: string,
): Promise<StorageMoveView> {
  const { data } = await client.request<StorageMoveView>({
    path: `${basePath(organizationSlug)}/migration-jobs/${encodeURIComponent(jobId)}`,
  });
  return data;
}
