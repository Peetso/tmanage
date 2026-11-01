'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DestructiveButton, InlineAlert, StateCapsule, TextButton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  attachMessageFile,
  detachMessageFile,
  listMessageAttachments,
} from '../../lib/api/message-attachments';
import type { MessageAttachmentSummary } from '../../lib/api/message-attachments';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

/** A file the caller may attach — an already-uploaded, ready file drawn from the project's store. */
export interface PickableFile {
  readonly fileId: string;
  readonly name: string;
}

export interface MessageAttachmentsViewProps {
  organizationSlug: string;
  conversationId: string;
  messageId: string;
  /** Whether the caller authored this message — only the author sees the attach/detach controls. */
  isAuthor?: boolean;
  /** Already-uploaded files the author may attach (the composer's "attach existing file" picker). */
  pickableFiles?: readonly PickableFile[];
  client?: ApiClient;
}

/** Human-readable byte size — `null` (no version yet) reads as a dash rather than "0 B". */
function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function message(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return t('MessageAttachmentsView.errorChange');
  if (error instanceof NetworkError) return t('MessageAttachmentsView.errorNetwork');
  return t('MessageAttachmentsView.errorGeneric');
}

/**
 * x275 — CH-06's composer attachments. Draws a message's attached files as chips and, for the
 * message's author, an "attach existing file" picker and per-chip detach. There is no upload here:
 * the picker offers files that already exist and are ready; attaching links one to the message.
 *
 * The API is idempotent (attach 200/201, detach 204) and enforces the author rule itself (403 for a
 * non-author), so the controls simply refetch the list on success and surface a refusal inline.
 */
export function MessageAttachmentsView({
  organizationSlug,
  conversationId,
  messageId,
  isAuthor = false,
  pickableFiles = [],
  client,
}: MessageAttachmentsViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const [selected, setSelected] = useState('');

  const queryKey = ['message-attachments', organizationSlug, conversationId, messageId] as const;

  const attachments = useQuery({
    queryKey,
    queryFn: () => listMessageAttachments(api, organizationSlug, conversationId, messageId),
  });

  const refetch = () => queryClient.invalidateQueries({ queryKey });

  const attach = useMutation({
    mutationFn: (fileId: string) =>
      attachMessageFile(api, organizationSlug, conversationId, messageId, fileId),
    onSuccess: () => {
      setSelected('');
      void refetch();
    },
  });

  const detach = useMutation({
    mutationFn: (fileId: string) =>
      detachMessageFile(api, organizationSlug, conversationId, messageId, fileId),
    onSuccess: () => void refetch(),
  });

  const rows: readonly MessageAttachmentSummary[] = attachments.data ?? [];
  const attachedIds = new Set(rows.map((row) => row.fileAssetId));
  const available = pickableFiles.filter((file) => !attachedIds.has(file.fileId));
  const error = attach.error ?? detach.error;

  return (
    <div className="tm-message-attachments">
      {rows.length > 0 ? (
        <ul className="tm-message-attachments__list">
          {rows.map((row) => (
            <li key={row.fileAssetId} className="tm-message-attachments__chip">
              {row.scanStatus === 'unavailable' ? (
                <span className="tm-message-attachments__name">{row.name}</span>
              ) : (
                <Link
                  className="tm-message-attachments__name"
                  href={`/${organizationSlug}/files/${encodeURIComponent(row.fileAssetId)}`}
                  aria-label={`${row.name} · ${t('Viewer.openInViewer')}`}
                >
                  {row.name}
                </Link>
              )}
              <span className="tm-message-attachments__size">{formatBytes(row.sizeBytes)}</span>
              {/* L2: the virus scan's word, the labels the channel's file cards use. */}
              {row.scanStatus === 'not_scanned' ? (
                <StateCapsule state="waiting" className="tm-scan-capsule">
                  {t('DownloadScan.notScanned')}
                </StateCapsule>
              ) : null}
              {row.scanStatus === 'being_checked' ? (
                <StateCapsule state="waiting" className="tm-scan-capsule">
                  {t('WorkDetail.scanning')}
                </StateCapsule>
              ) : null}
              {row.scanStatus === 'unavailable' ? (
                <span className="tm-message-attachments__size" role="status">
                  {t('WorkDetail.unavailable')}
                </span>
              ) : null}
              {isAuthor ? (
                <DestructiveButton
                  type="button"
                  disabled={detach.isPending}
                  onClick={() => detach.mutate(row.fileAssetId)}
                >
                  {t('MessageAttachmentsView.remove')}
                </DestructiveButton>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="tm-message-attachments__empty">{t('MessageAttachmentsView.empty')}</p>
      )}

      {isAuthor && available.length > 0 ? (
        <div className="tm-message-attachments__picker">
          <label>
            <span className="tm-visually-hidden">{t('MessageAttachmentsView.pickerLabel')}</span>
            <select
              value={selected}
              disabled={attach.isPending}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">{t('MessageAttachmentsView.pickerPlaceholder')}</option>
              {available.map((file) => (
                <option key={file.fileId} value={file.fileId}>
                  {file.name}
                </option>
              ))}
            </select>
          </label>
          <TextButton
            type="button"
            disabled={attach.isPending || selected === ''}
            onClick={() => attach.mutate(selected)}
          >
            {t('MessageAttachmentsView.attach')}
          </TextButton>
        </div>
      ) : null}

      {error ? (
        <InlineAlert tone="danger" live>
          {message(t, error)}
        </InlineAlert>
      ) : null}
    </div>
  );
}
