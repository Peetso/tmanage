import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from './api/client';
import { getStorageStatus } from './api/google-drive';
import type { StorageStatusView } from './api/google-drive';
import { getOneDriveStatus } from './api/onedrive';
import type { OneDriveStatusView } from './api/onedrive';
import type { StorageMoveView, StorageProvider } from './api/storage-root';
import { isStorageMoveActive, useStorageMove } from './use-storage-move';

/**
 * 57-13c. "Where your files live" on Plan & usage (Figma 668:36868): which of the six states the
 * card shows, from the company's latest move job and the Google Drive / OneDrive connections.
 * The status reads share their keys with Control > Storage, so both screens see one answer.
 */

export type StorageStopReason = 'not_connected' | 'provider_unavailable' | 'connection_changed';

export interface StorageConnection {
  readonly provider: StorageProvider;
  readonly account: string | null;
}

export type StorageCardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'connect' }
  | { readonly kind: 'ready'; readonly connection: StorageConnection }
  | { readonly kind: 'moving'; readonly job: StorageMoveView }
  | { readonly kind: 'done'; readonly job: StorageMoveView }
  | { readonly kind: 'stopped'; readonly job: StorageMoveView; readonly reason: StorageStopReason };

export interface StorageCardInput {
  readonly job: StorageMoveView | null;
  readonly google: StorageStatusView | undefined;
  readonly oneDrive: OneDriveStatusView | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

/** An unknown stop reason reads as "not reachable": its way forward, Try again, is always safe. */
function stopReason(error: string | null): StorageStopReason {
  return error === 'not_connected' || error === 'connection_changed'
    ? error
    : 'provider_unavailable';
}

/** The connected provider, preferring the one the company already stores in. */
export function connectedStorage(
  google: StorageStatusView | undefined,
  oneDrive: OneDriveStatusView | undefined,
): StorageConnection | null {
  const drive: StorageConnection | null =
    google?.googleDrive.status === 'connected'
      ? { provider: 'google_drive', account: google.googleDrive.accountEmail }
      : null;
  const one: StorageConnection | null =
    oneDrive?.oneDrive.status === 'connected'
      ? { provider: 'onedrive', account: oneDrive.oneDrive.accountEmail }
      : null;
  const mode = google?.storageMode ?? oneDrive?.storageMode;
  return mode === 'onedrive' ? (one ?? drive) : (drive ?? one);
}

export function storageCardState(input: StorageCardInput): StorageCardState {
  const { job } = input;
  if (job !== null) {
    if (isStorageMoveActive(job)) return { kind: 'moving', job };
    if (job.status === 'stopped') return { kind: 'stopped', job, reason: stopReason(job.error) };
    return { kind: 'done', job };
  }
  if (input.isError) return { kind: 'error' };
  if (input.isPending) return { kind: 'loading' };
  const connection = connectedStorage(input.google, input.oneDrive);
  return connection === null ? { kind: 'connect' } : { kind: 'ready', connection };
}

export interface StorageCardModel {
  readonly state: StorageCardState;
  readonly isStarting: boolean;
  readonly startError: unknown;
  readonly start: (provider: StorageProvider) => void;
}

export function useStorageCard(api: ApiClient, organizationSlug: string): StorageCardModel {
  const move = useStorageMove(api, organizationSlug, true);
  const google = useQuery({
    queryKey: ['storage-status', organizationSlug],
    queryFn: () => getStorageStatus(api, organizationSlug),
  });
  const oneDrive = useQuery({
    queryKey: ['onedrive-status', organizationSlug],
    queryFn: () => getOneDriveStatus(api, organizationSlug),
  });
  const state = storageCardState({
    job: move.job,
    google: google.data,
    oneDrive: oneDrive.data,
    isPending: move.isPending || google.isPending || oneDrive.isPending,
    isError: move.isError || (google.isError && oneDrive.isError),
  });
  return {
    state,
    isStarting: move.isStarting,
    startError: move.startError,
    start: move.start,
  };
}
