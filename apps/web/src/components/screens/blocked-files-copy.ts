/**
 * 56-06 Blocked files copy — the English each `BlockedFiles.*` key falls back to until the R44 L2
 * i18n fragment is merged into the catalogs (see `useTOr`).
 */
export const BLOCKED_FILES_COPY = {
  crumbSecurity: 'Security',
  title: 'Blocked files',
  description:
    'Uploads the safety check stopped. Delete one now to free its space; otherwise it is removed after the retention window.',
  loading: 'Loading blocked files',
  loadError: 'The blocked files could not be loaded',
  deleteError: 'The file could not be deleted',
  filtersLabel: 'Filter by reason',
  all: 'All',
  empty: 'No blocked files. Every upload passed the safety check.',
  tableLabel: 'Blocked files',
  colFile: 'File',
  colType: 'Type',
  colReason: 'Reason',
  colUploadedBy: 'Uploaded by',
  colDate: 'Date',
  colActions: 'Actions',
  reasonMalware: 'Malware found',
  reasonTypeNotAllowed: 'Type not allowed',
  reasonTypeMismatch: 'Type mismatch',
  reasonHashMismatch: 'Upload was damaged',
  reasonOther: 'Other safety rule',
  formerMember: 'Former member',
  deleteNow: 'Delete now',
  deleting: 'Deleting…',
  neverReleased: 'A blocked file is never released. Ask the person to upload a safe copy instead.',
} as const;

export type BlockedFilesCopyKey = keyof typeof BLOCKED_FILES_COPY;
