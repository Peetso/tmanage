import { ApiRequestError } from './api/errors';
import type { MessageKey } from './i18n/t';

/**
 * FIX6 C1/C2. The plain words for why a picked Google Drive or OneDrive file could not be added,
 * read from the token the API puts in the error's details. `null` for any other error, which the
 * screen describes as it already does.
 */
export function cloudImportMessageKey(error: unknown): MessageKey | null {
  if (!(error instanceof ApiRequestError)) return null;
  const tokens = new Set(error.details.map((detail) => `${detail.field}:${detail.message}`));
  if (tokens.has('file:drive_file_gone')) return 'CloudImport.fileGone';
  if (tokens.has('file:drive_no_access')) return 'CloudImport.noAccess';
  if (tokens.has('file:google_native_format')) return 'CloudImport.googleNative';
  if (tokens.has('reason:too_large')) return 'CloudImport.tooLarge';
  if (tokens.has('storage:not_connected') || tokens.has('storage:not_configured')) {
    return 'CloudImport.notConnected';
  }
  if (tokens.has('storage:unreachable') || tokens.has('storage:consent_required')) {
    return 'CloudImport.unreachable';
  }
  return null;
}
