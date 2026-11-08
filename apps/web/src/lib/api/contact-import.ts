import type { ApiClient } from './client';

/**
 * r46 · 54-11 — import contacts from a CSV or vCard file into the caller's own invite list (and,
 * when asked, new client companies). The file is read in the browser and sent as text; the API
 * answers with counts and, for the preview, the caller's own rows — never anyone else's.
 */

export type ContactFileFormat = 'csv' | 'vcard';

export interface ContactColumnMappingInput {
  readonly email: number;
  readonly name: number | null;
  readonly company: number | null;
}

export type ContactPreviewStatus =
  'new' | 'existing' | 'duplicate' | 'missing_email' | 'invalid_email';

export interface ContactPreviewRow {
  readonly line: number;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly company: string | null;
  readonly status: ContactPreviewStatus;
}

export interface ContactErrorRecord {
  readonly line: number;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly company: string | null;
  readonly outcome: 'ok' | 'missing_email' | 'invalid_email' | 'duplicate';
}

export interface ContactImportPreview {
  readonly format: ContactFileFormat;
  readonly header: readonly string[] | null;
  readonly mapping: ContactColumnMappingInput | null;
  readonly counts: {
    readonly total: number;
    readonly new: number;
    readonly existing: number;
    readonly duplicate: number;
    readonly invalid: number;
    readonly overLimit: number;
  };
  readonly rows: readonly ContactPreviewRow[];
  readonly errors: readonly ContactErrorRecord[];
  readonly companies: readonly { readonly name: string; readonly isNew: boolean }[];
}

export interface ContactImportResult {
  readonly imported: number;
  readonly updated: number;
  readonly skipped: number;
  readonly clientsCreated: number;
}

export interface ContactImportInput {
  readonly format: ContactFileFormat;
  readonly text: string;
  readonly mapping?: ContactColumnMappingInput | null;
  readonly createClients?: boolean;
}

/** `.vcf` / `.vcard` (or a text that starts with BEGIN:VCARD) is a vCard; anything else is CSV. */
export function contactFileFormat(fileName: string, text: string): ContactFileFormat {
  if (/\.(vcf|vcard)$/i.test(fileName)) return 'vcard';
  return /^\uFEFF?\s*BEGIN:VCARD/i.test(text) ? 'vcard' : 'csv';
}

function contactsPath(organizationSlug: string, leaf: string): string {
  return `/v1/organizations/${encodeURIComponent(organizationSlug)}/contacts/${leaf}`;
}

export async function previewContactImport(
  client: ApiClient,
  organizationSlug: string,
  input: ContactImportInput,
): Promise<ContactImportPreview> {
  const { data } = await client.request<ContactImportPreview>({
    method: 'POST',
    path: contactsPath(organizationSlug, 'import-preview'),
    body: { format: input.format, text: input.text, mapping: input.mapping ?? null },
  });
  return data;
}

export async function importContacts(
  client: ApiClient,
  organizationSlug: string,
  input: ContactImportInput,
): Promise<ContactImportResult> {
  const { data } = await client.request<ContactImportResult>({
    method: 'POST',
    path: contactsPath(organizationSlug, 'import-file'),
    body: {
      format: input.format,
      text: input.text,
      mapping: input.mapping ?? null,
      createClients: input.createClients === true,
    },
  });
  return data;
}
