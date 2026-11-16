import type { StorageConnectionRow } from '../../common/database/schema.js';

/**
 * 51-17 (0356). Who owns the place a company's `TManage/` root sits in.
 *
 * Company-owned: a Google Shared Drive, or a SharePoint / OneDrive-for-Business document library.
 * Personal: one person's My Drive or OneDrive — when that account is removed, the files go with
 * it, so the Storage screen recommends a company-owned root. `unknown`: a OneDrive row saved
 * before 0356 (its drive type was not kept) until its location is saved again.
 */
export const ROOT_OWNER_KINDS = [
  'shared_drive',
  'sharepoint_library',
  'personal',
  'unknown',
] as const;
export type RootOwnerKind = (typeof ROOT_OWNER_KINDS)[number];

/** A Google root: inside a Shared Drive (the folder's `driveId`), or in someone's My Drive. */
export function googleRootOwner(sharedDriveId: string | null): RootOwnerKind {
  return sharedDriveId ? 'shared_drive' : 'personal';
}

/**
 * A OneDrive root, from Graph's `driveType`: `documentLibrary` is a SharePoint library; `personal`
 * and `business` are one person's OneDrive (consumer or work) — personal either way.
 */
export function oneDriveRootOwner(driveType: string): RootOwnerKind {
  if (driveType === 'documentLibrary') return 'sharepoint_library';
  if (driveType === 'personal' || driveType === 'business') return 'personal';
  return 'unknown';
}

/**
 * 51-17 slice 2. One company-owned place the connected account can put the root in: a Google
 * Shared Drive it may add files to, or a SharePoint document library. Read from the provider on the
 * server; a saved id must be one of these.
 */
export interface CompanyRootOption {
  readonly id: string;
  readonly name: string;
}

export interface CompanyRootOptionsView {
  readonly kind: 'shared_drive' | 'sharepoint_library';
  readonly options: readonly CompanyRootOption[];
}

function storedKind(value: string): RootOwnerKind {
  return (ROOT_OWNER_KINDS as readonly string[]).includes(value)
    ? (value as RootOwnerKind)
    : 'unknown';
}

/** The owner badge and the hand-over state, as the Storage screen reads them. */
export interface RootOwnerView {
  readonly kind: RootOwnerKind;
  /** True for a Shared Drive or a SharePoint library. */
  readonly companyOwned: boolean;
  /** The steer: the root is in one person's drive, so a company-owned place is recommended. */
  readonly recommendCompanyRoot: boolean;
  /** Whether the person reading connected this account (managers only; false otherwise). */
  readonly connectedByMe: boolean;
  /** `pending_for_me`: this person was asked to take over and must reconnect with their account. */
  readonly handover: 'none' | 'pending' | 'pending_for_me';
}

export function toRootOwnerView(
  live: StorageConnectionRow | undefined,
  viewerUserId: string | null,
  canManage: boolean,
): RootOwnerView | null {
  if (!live) return null;
  const kind = storedKind(live.rootOwnerKind);
  const companyOwned = kind === 'shared_drive' || kind === 'sharepoint_library';
  const handover = !canManage
    ? 'none'
    : !live.handoverToUserId
      ? 'none'
      : viewerUserId !== null && live.handoverToUserId === viewerUserId
        ? 'pending_for_me'
        : 'pending';
  return {
    kind,
    companyOwned,
    recommendCompanyRoot: kind === 'personal',
    connectedByMe: canManage && viewerUserId !== null && live.connectedByUserId === viewerUserId,
    handover,
  };
}

/**
 * Whether this sign-in completes a pending hand-over: the live connection names this person as
 * the one to take it over, and it still has a root to keep.
 */
export function pendingHandoverFor(
  row: StorageConnectionRow | undefined,
  userId: string,
): (StorageConnectionRow & { rootFolderId: string }) | null {
  if (!row || row.status === 'disconnected' || !row.rootFolderId) return null;
  if (row.handoverToUserId !== userId) return null;
  return row as StorageConnectionRow & { rootFolderId: string };
}
