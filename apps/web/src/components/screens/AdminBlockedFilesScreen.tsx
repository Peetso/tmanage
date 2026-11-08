'use client';

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  blockReason,
  deleteBlockedFile,
  filterBlocked,
  listBlockedFiles,
} from '../../lib/api/admin-blocked-files';
import type {
  BlockReason,
  BlockReasonFilter,
  BlockedFileView,
} from '../../lib/api/admin-blocked-files';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useOrganizationName } from '../../lib/use-organization-names';
import { BLOCKED_FILES_COPY } from './blocked-files-copy';
import type { BlockedFilesCopyKey } from './blocked-files-copy';
import '../../styles/screens/r44-security-growth.css';

export interface AdminBlockedFilesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const REASON_COPY: Record<BlockReason, BlockedFilesCopyKey> = {
  malware_detected: 'reasonMalware',
  type_not_allowed: 'reasonTypeNotAllowed',
  type_mismatch: 'reasonTypeMismatch',
  hash_mismatch: 'reasonHashMismatch',
  other: 'reasonOther',
};
const REASON_TONE: Record<BlockReason, StatusTone> = {
  malware_detected: 'danger',
  type_not_allowed: 'warning',
  type_mismatch: 'warning',
  hash_mismatch: 'warning',
  other: 'neutral',
};
const CHIPS: readonly BlockReasonFilter[] = [
  'all',
  'malware_detected',
  'type_not_allowed',
  'type_mismatch',
];

function useCopy(): (key: BlockedFilesCopyKey) => string {
  const tOr = useTOr();
  return useCallback(
    (key: BlockedFilesCopyKey) => tOr(`BlockedFiles.${key}`, BLOCKED_FILES_COPY[key]),
    [tOr],
  );
}

/**
 * **Blocked files** (56-06, Figma 578:32859 "Blocked files · EN/AR") — the uploads the safety check
 * refused, newest first, with the reason, the type, the uploader and the date. "Delete now" frees
 * the space at once instead of waiting for the retention window. There is no release: a refused
 * file is never served (the API's state machine), so the page says to ask for a safe copy.
 */
export function AdminBlockedFilesScreen({
  organizationSlug,
  organizationName: passedName,
  client,
}: AdminBlockedFilesScreenProps) {
  const organizationName = useOrganizationName(organizationSlug, passedName);
  const api = client ?? browserApiClient();
  const copy = useCopy();
  const describe = useDescribeApiError();
  const format = useDisplayFormatters();
  const queries = useQueryClient();
  const queryKey = ['admin-blocked-files', organizationSlug];
  const [filter, setFilter] = useState<BlockReasonFilter>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const files = useQuery({ queryKey, queryFn: () => listBlockedFiles(api, organizationSlug) });
  const remove = useMutation({
    mutationFn: (fileId: string) => deleteBlockedFile(api, organizationSlug, fileId),
    onMutate: (fileId: string) => setDeletingId(fileId),
    onSettled: async () => {
      setDeletingId(null);
      await queries.invalidateQueries({ queryKey });
    },
  });

  const all = files.data ?? [];
  const rows = filterBlocked(all, filter);
  const chipLabel = (chip: BlockReasonFilter) =>
    chip === 'all'
      ? `${copy('all')} · ${format.number(all.length)}`
      : copy(REASON_COPY[chip as BlockReason]);

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="security"
      crumbs={[copy('crumbSecurity'), copy('title')]}
      title={copy('title')}
    >
      <p className="tm-r44-lede">{copy('description')}</p>

      {files.isPending ? (
        <LoadingRegion label={copy('loading')} className="tm-stack tm-stack--tight">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}
      {files.isError ? (
        <InlineAlert tone="danger" title={copy('loadError')} live>
          {describe(files.error)}
        </InlineAlert>
      ) : null}
      {remove.isError ? (
        <InlineAlert tone="danger" title={copy('deleteError')} live>
          {describe(remove.error)}
        </InlineAlert>
      ) : null}

      {files.isSuccess ? (
        <div className="tm-r44-chips" role="group" aria-label={copy('filtersLabel')}>
          {CHIPS.map((chip) => (
            <button
              key={chip}
              type="button"
              className={filter === chip ? 'tm-chip tm-chip--active' : 'tm-chip'}
              aria-pressed={filter === chip}
              onClick={() => setFilter(chip)}
            >
              {chipLabel(chip)}
            </button>
          ))}
        </div>
      ) : null}

      {files.isSuccess && rows.length === 0 ? (
        <InlineAlert tone="neutral">{copy('empty')}</InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <section className="tm-cc-card tm-cc-card--flush" aria-labelledby="tm-blocked-heading">
          <h2 id="tm-blocked-heading" className="tm-visually-hidden">
            {copy('title')}
          </h2>
          <table className="tm-table tm-cc-table" aria-label={copy('tableLabel')}>
            <thead>
              <tr>
                <th scope="col">{copy('colFile')}</th>
                <th scope="col">{copy('colType')}</th>
                <th scope="col">{copy('colReason')}</th>
                <th scope="col">{copy('colUploadedBy')}</th>
                <th scope="col">{copy('colDate')}</th>
                <th scope="col">
                  <span className="tm-visually-hidden">{copy('colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((file) => (
                <BlockedRow
                  key={file.id}
                  file={file}
                  busy={remove.isPending && deletingId === file.id}
                  onDelete={() => remove.mutate(file.id)}
                />
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <p className="tm-r44-note">{copy('neverReleased')}</p>
    </ControlCenterShell>
  );
}

function BlockedRow({
  file,
  busy,
  onDelete,
}: {
  file: BlockedFileView;
  busy: boolean;
  onDelete: () => void;
}) {
  const copy = useCopy();
  const format = useDisplayFormatters();
  const reason = blockReason(file.reason);
  return (
    <tr>
      <th scope="row">
        <bdi dir="ltr" className="tm-cc-cell-title">
          {file.name}
        </bdi>
      </th>
      <td className="tm-cc-cell-mono" title={file.detectedMimeType ?? file.declaredMimeType ?? ''}>
        {file.extension || '—'}
      </td>
      <td>
        <StatusDot tone={REASON_TONE[reason]}>{copy(REASON_COPY[reason])}</StatusDot>
      </td>
      <td>{file.uploadedBy ?? copy('formerMember')}</td>
      <td className="tm-cc-cell-sub">
        {format.day(file.blockedAt, { day: 'numeric', month: 'short' })}
      </td>
      <td className="tm-cc-end">
        <Button type="button" tone="destructive" size="compact" disabled={busy} onClick={onDelete}>
          {busy ? copy('deleting') : copy('deleteNow')}
        </Button>
      </td>
    </tr>
  );
}
