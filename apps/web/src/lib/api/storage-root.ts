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
