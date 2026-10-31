import type { StorageStatusView } from './api/google-drive';
import type { OneDriveStatusView } from './api/onedrive';

/**
 * Owner decision 2026-10-26: a company's files live in Google Drive or OneDrive, never on
 * TManage. Until one of them is the company's storage, attaching files is not possible, and the
 * attach area says so (Figma 419:23811 owner, 419:23844 everyone else). Avatars, logos and system
 * exports are not attachments and are unaffected.
 *
 * - `unknown`: the status has not been read (loading, or the read failed); the attach controls
 *   stay as they were rather than flashing a "no storage" state that may be wrong.
 * - `ready`: Google Drive or OneDrive is the company's storage.
 * - `connect`: no storage yet, and this person may choose it (Connect storage).
 * - `ask`: no storage yet, and only an owner or admin may choose it (Ask your admin).
 */
/**
 * Owner decision 2026-10-31: TManage storage (1 GB per company) is offered again and is the
 * default, so no company is ever without storage and the first-time choice is not forced.
 */
export const TMANAGE_STORAGE_OFFERED = true;

export type AttachStorageState = 'unknown' | 'ready' | 'connect' | 'ask';

export function attachStorageState(
  storage: Pick<StorageStatusView, 'storageMode'> | undefined,
  canManage: boolean,
): AttachStorageState {
  if (storage === undefined) return 'unknown';
  // 2026-10-31: TManage storage is a real choice again, so every mode can take attachments.
  if (TMANAGE_STORAGE_OFFERED) return 'ready';
  if (storage.storageMode === 'google_drive' || storage.storageMode === 'onedrive') return 'ready';
  return canManage ? 'connect' : 'ask';
}

/**
 * Control > Storage opens on the first-time choice (Figma 419:23593 / 419:23699) while neither
 * Google Drive nor OneDrive has ever been connected: no connection, no broken connection, and
 * neither one the company's storage.
 */
export function isFirstTimeStorage(
  storage: StorageStatusView | undefined,
  oneDrive: OneDriveStatusView | undefined,
): boolean {
  if (TMANAGE_STORAGE_OFFERED) return false;
  if (storage === undefined || oneDrive === undefined) return false;
  if (storage.storageMode === 'google_drive' || storage.storageMode === 'onedrive') return false;
  return (
    storage.googleDrive.status === 'not_connected' && oneDrive.oneDrive.status === 'not_connected'
  );
}
