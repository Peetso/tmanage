'use client';

import { useState, type ChangeEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CONTACT_ERROR_REPORT_HEADER, contactErrorReportRows, toCsv } from '@tmanage/domain';
import { Badge, Button, Checkbox, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import {
  contactFileFormat,
  importContacts,
  previewContactImport,
  type ContactColumnMappingInput,
  type ContactFileFormat,
  type ContactImportPreview,
  type ContactImportResult,
  type ContactPreviewStatus,
} from '../../lib/api/contact-import';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useTOr } from '../../lib/i18n/use-t-or';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/r46-repeat-contacts.css';

export interface ContactsImportScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The 2 MB cap the API enforces, checked before the file is read. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface LoadedFile {
  readonly name: string;
  readonly text: string;
  readonly format: ContactFileFormat;
}

/** Save `text` as a file through a temporary link (the error report). */
function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * **54-11 · Import contacts** (Figma 587:33749 EN / 587:33830 AR) — Clients → Import contacts.
 *
 * Upload a Google / Outlook CSV or a vCard file (read in the browser, ≤ 2 MB); match the CSV's
 * columns to e-mail, name and company; check every row before importing — new, already in your
 * list, repeated in the file (duplicates by e-mail), or an error; download the error report as
 * CSV; then import into your invite list and, optionally, add the file's new companies as client
 * companies. The preview writes nothing; only "Import" does.
 */
export function ContactsImportScreen({
  organizationSlug,
  organizationName,
  client,
}: ContactsImportScreenProps) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ContactColumnMappingInput | null>(null);
  const [createClients, setCreateClients] = useState(false);
  const [done, setDone] = useState<ContactImportResult | null>(null);

  const preview = useMutation({
    mutationFn: (input: { file: LoadedFile; mapping: ContactColumnMappingInput | null }) =>
      previewContactImport(api, organizationSlug, {
        format: input.file.format,
        text: input.file.text,
        mapping: input.mapping,
      }),
    onSuccess: (result: ContactImportPreview) => setMapping(result.mapping),
  });

  const commit = useMutation({
    mutationFn: () =>
      importContacts(api, organizationSlug, {
        format: file!.format,
        text: file!.text,
        mapping,
        createClients,
      }),
    onSuccess: (result) => setDone(result),
  });

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    setDone(null);
    setFileError(null);
    if (!chosen) return;
    if (chosen.size > MAX_FILE_BYTES) {
      setFile(null);
      setFileError(tOr('ContactsImport.tooLarge', 'The file is larger than 2 MB.'));
      return;
    }
    const text = await chosen.text();
    const loaded = { name: chosen.name, text, format: contactFileFormat(chosen.name, text) };
    setFile(loaded);
    setMapping(null);
    preview.mutate({ file: loaded, mapping: null });
  }

  function remap(field: keyof ContactColumnMappingInput, raw: string) {
    if (!file || !mapping) return;
    const value = raw === '' ? null : Number(raw);
    if (field === 'email' && value === null) return;
    const next = { ...mapping, [field]: value } as ContactColumnMappingInput;
    setMapping(next);
    preview.mutate({ file, mapping: next });
  }

  const statusText: Record<ContactPreviewStatus, string> = {
    new: tOr('ContactsImport.statusNew', 'New'),
    existing: tOr('ContactsImport.statusExisting', 'Already in your list'),
    duplicate: tOr('ContactsImport.statusDuplicate', 'Repeated in file'),
    missing_email: tOr('ContactsImport.statusMissing', 'No e-mail'),
    invalid_email: tOr('ContactsImport.statusInvalid', 'Invalid e-mail'),
  };
  const data = preview.data;
  const newCompanies = data ? data.companies.filter((c) => c.isNew).length : 0;
  const importable = data ? data.counts.new + data.counts.existing : 0;
  const step = done ? 4 : data ? 3 : file ? 2 : 1;
  const steps = [
    tOr('ContactsImport.stepUpload', '1 Upload'),
    tOr('ContactsImport.stepMatch', '2 Match columns'),
    tOr('ContactsImport.stepCheck', '3 Check'),
    tOr('ContactsImport.stepImport', '4 Import'),
  ];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={tOr('ContactsImport.title', 'Import contacts')}
      titleVariant="display"
      description={tOr(
        'ContactsImport.intro',
        'Bring people in from a Google or Outlook CSV, or a vCard file. Nothing is saved until you import.',
      )}
    >
      <div className="tm-r46-card">
        <ol className="tm-r46-row" aria-label={tOr('ContactsImport.steps', 'Steps')}>
          {steps.map((label, index) => (
            <li key={label} aria-current={index + 1 === step ? 'step' : undefined}>
              <Badge tone={index + 1 === step ? 'client' : 'neutral'}>{label}</Badge>
            </li>
          ))}
        </ol>

        <div className="tm-r46-drop">
          <label className="tm-field__label" htmlFor="tm-r46-file">
            {tOr('ContactsImport.drop', 'Choose a CSV or vCard file (up to 2 MB, 5,000 rows)')}
          </label>
          <input
            id="tm-r46-file"
            type="file"
            accept=".csv,.vcf,.vcard,text/csv,text/vcard"
            onChange={(event) => void onFile(event)}
          />
          {file ? <p className="tm-r46-lede">{file.name}</p> : null}
        </div>

        {fileError ? (
          <InlineAlert
            tone="danger"
            title={tOr('ContactsImport.fileErrorTitle', 'File not used')}
            live
          >
            {fileError}
          </InlineAlert>
        ) : null}

        {preview.isPending ? (
          <LoadingRegion label={tOr('ContactsImport.reading', 'Reading the file')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {preview.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('ContactsImport.previewError', 'Could not read the file')}
            live
          >
            {describe(preview.error)}
          </InlineAlert>
        ) : null}

        {data && data.header && mapping ? (
          <section className="tm-r46-group" aria-labelledby="tm-r46-map">
            <h2 id="tm-r46-map" className="tm-eyebrow">
              {tOr('ContactsImport.matchTitle', 'Match columns')}
            </h2>
            <div className="tm-r46-map">
              {(
                [
                  ['email', tOr('ContactsImport.colEmail', 'E-mail')],
                  ['name', tOr('ContactsImport.colName', 'Name')],
                  ['company', tOr('ContactsImport.colCompany', 'Company')],
                ] as const
              ).map(([field, label]) => (
                <Select
                  key={field}
                  label={label}
                  value={mapping[field] === null ? '' : String(mapping[field])}
                  onChange={(event) => remap(field, event.target.value)}
                >
                  {field !== 'email' ? (
                    <option value="">{tOr('ContactsImport.notInFile', 'Not in the file')}</option>
                  ) : null}
                  {data.header!.map((cell, index) => (
                    <option key={index} value={index}>
                      {cell === '' ? `#${index + 1}` : cell}
                    </option>
                  ))}
                </Select>
              ))}
            </div>
          </section>
        ) : null}

        {data ? (
          <section className="tm-r46-group" aria-labelledby="tm-r46-check">
            <h2 id="tm-r46-check" className="tm-eyebrow">
              {tOr('ContactsImport.checkTitle', 'Check before importing')}
            </h2>
            <p className="tm-r46-lede" data-testid="tm-r46-summary">
              {`${data.counts.new} ${tOr('ContactsImport.sumNew', 'new')} · ${data.counts.existing} ${tOr('ContactsImport.sumExisting', 'already in your list')} · ${data.counts.duplicate} ${tOr('ContactsImport.sumDuplicate', 'repeated in the file')} · ${data.counts.invalid + data.counts.overLimit} ${tOr('ContactsImport.sumErrors', 'with errors')}`}
            </p>
            <table className="tm-r46-table">
              <thead>
                <tr>
                  <th scope="col">{tOr('ContactsImport.colName', 'Name')}</th>
                  <th scope="col">{tOr('ContactsImport.colEmail', 'E-mail')}</th>
                  <th scope="col">{tOr('ContactsImport.colCompany', 'Company')}</th>
                  <th scope="col">{tOr('ContactsImport.colStatus', 'Status')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => {
                  const bad = row.status === 'missing_email' || row.status === 'invalid_email';
                  return (
                    <tr key={row.line}>
                      <td>{row.displayName ?? '—'}</td>
                      <td dir="ltr">{row.email ?? '—'}</td>
                      <td>{row.company ?? '—'}</td>
                      {bad ? (
                        <td className="tm-r46-bad">{statusText[row.status]}</td>
                      ) : (
                        <td>
                          <Badge tone={row.status === 'new' ? 'client' : 'neutral'}>
                            {statusText[row.status]}
                          </Badge>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {newCompanies > 0 ? (
              <Checkbox
                label={`${tOr('ContactsImport.createClients', 'Also add new client companies from the Company column')} (${newCompanies})`}
                checked={createClients}
                onChange={(event) => setCreateClients(event.target.checked)}
              />
            ) : null}

            {commit.isError ? (
              <InlineAlert
                tone="danger"
                title={tOr('ContactsImport.importError', 'Import failed')}
                live
              >
                {describe(commit.error)}
              </InlineAlert>
            ) : null}

            {done ? (
              <InlineAlert
                tone="success"
                title={tOr('ContactsImport.doneTitle', 'Contacts imported')}
                live
              >
                {`${done.imported + done.updated} ${tOr('ContactsImport.doneContacts', 'contacts are in your invite list.')}${done.clientsCreated > 0 ? ` ${done.clientsCreated} ${tOr('ContactsImport.doneClients', 'client companies added.')}` : ''}`}
              </InlineAlert>
            ) : null}

            <div className="tm-r46-row">
              <Button
                type="button"
                tone="ink"
                size="accessible"
                loading={commit.isPending}
                loadingLabel={tOr('ContactsImport.importing', 'Importing')}
                disabled={importable === 0 || commit.isPending || done !== null}
                onClick={() => commit.mutate()}
              >
                {`${tOr('ContactsImport.importButton', 'Import contacts')} (${importable})`}
              </Button>
              <Button
                type="button"
                tone="outline"
                size="accessible"
                disabled={data.errors.length === 0}
                onClick={() =>
                  download(
                    'contacts-import-errors.csv',
                    toCsv(contactErrorReportRows(data.errors), CONTACT_ERROR_REPORT_HEADER, {
                      bom: true,
                    }),
                  )
                }
              >
                {tOr('ContactsImport.errorReport', 'Download error report')}
              </Button>
              <Button
                type="button"
                tone="text"
                size="accessible"
                onClick={() => {
                  setFile(null);
                  setMapping(null);
                  setDone(null);
                  preview.reset();
                }}
              >
                {tOr('ContactsImport.cancel', 'Cancel')}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
