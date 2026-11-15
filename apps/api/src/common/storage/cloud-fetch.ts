import { ApiError } from '../http/errors.js';
import { DownloadTooLargeError } from './capped-body.js';

/**
 * FIX6 C1. What a storage provider service hands the import: a picked file's bytes, fetched on the
 * server with the company connection. Never a token, never a download link.
 */
export interface FetchedCloudFile {
  readonly provider: 'google_drive' | 'onedrive';
  /** The provider's id for the file (Drive file id, or OneDrive `driveId:itemId`). */
  readonly externalId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

/**
 * FIX6 C1. The honest states of an import, each with its own token for the web copy. A connection
 * that is gone keeps the providers' existing 409 (`storage: not_connected`).
 */
export function cloudFileGone(): ApiError {
  return new ApiError(404, 'not_found', 'The file is no longer in the drive', [
    { field: 'file', message: 'drive_file_gone' },
  ]);
}

export function cloudNoAccess(): ApiError {
  return new ApiError(403, 'forbidden', 'The drive does not let TManage open this file', [
    { field: 'file', message: 'drive_no_access' },
  ]);
}

/** The same 422 shape as the upload door's own size refusal. */
export function cloudTooLarge(): ApiError {
  return new ApiError(
    422,
    'file_not_allowed',
    'This file cannot be uploaded',
    [{ field: 'reason', message: 'too_large' }],
    'file_not_allowed:too_large',
  );
}

/** Map the download's size refusal; anything else is rethrown for the provider's own mapping. */
export function rethrowTooLarge(error: unknown): never {
  if (error instanceof DownloadTooLargeError) throw cloudTooLarge();
  throw error;
}
