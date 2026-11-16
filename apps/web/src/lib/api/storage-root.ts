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
