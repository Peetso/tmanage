'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  getDocumentVersion,
  listDocumentVersions,
  restoreDocumentVersion,
} from '../../lib/api/documents';
import type { DocumentPerson, DocumentVersionSummary } from '../../lib/api/documents';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { DocMarkdown } from './DocMarkdown';
import { tagFor } from './doc-markdown';
import { DocBodyView } from './editor/DocBodyView';
import './doc-history-panel.css';

/** Slice 3 adds `bodyFormat` to the version view; read it optionally until then. */
function formatOf(version: DocumentVersionSummary): 'markdown' | 'html' {
  return (version as { bodyFormat?: 'markdown' | 'html' }).bodyFormat ?? 'markdown';
}

export interface DocHistoryPanelProps {
  organizationSlug: string;
  documentId: string;
  client: ApiClient;
  /** The document's people, to name each version's editor. */
  people?: readonly DocumentPerson[];
  /** The version being previewed; null = the current one. */
  selectedVersionNo: number | null;
  onSelect: (versionNo: number | null) => void;
  onClose: () => void;
}

/**
 * **Docs version history side panel — R5 frame 9 (Figma 487:28939).**
 *
 * The versions newest first (editor and time), the current one on top; picking an older one shows
 * it read-only in the sheet ({@link DocVersionPreview}) and arms "Restore version N", which goes
 * through the existing forward-append restore — history stays intact, the restore is a new version.
 */
export function DocHistoryPanel({
  organizationSlug,
  documentId,
  client,
  people = [],
  selectedVersionNo,
  onSelect,
  onClose,
}: DocHistoryPanelProps) {
  const t = useT();
  const locale = useActiveLocale();
  const describeError = useDescribeApiError();
  const queryClient = useQueryClient();

  const versions = useQuery({
    queryKey: ['document-versions', organizationSlug, documentId],
    queryFn: () => listDocumentVersions(client, organizationSlug, documentId),
  });

  const restore = useMutation({
    mutationFn: (versionNo: number) =>
      restoreDocumentVersion(client, organizationSlug, documentId, versionNo),
    onSuccess: async () => {
      onSelect(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['document', organizationSlug, documentId] }),
        queryClient.invalidateQueries({
          queryKey: ['document-versions', organizationSlug, documentId],
        }),
      ]);
    },
  });

  const rows = [...(versions.data ?? [])].sort((a, b) => b.versionNo - a.versionNo);
  const currentNo = rows[0]?.versionNo ?? null;
  const picked = selectedVersionNo !== null && selectedVersionNo !== currentNo;
  const nameOf = (userId: string) =>
    people.find((person) => person.userId === userId)?.displayName ?? '';

  return (
    <section className="tm-dx-edge tm-doc-history" aria-labelledby="tm-doc-history-title">
      <div className="tm-doc-rail__head">
        <h2 id="tm-doc-history-title" className="tm-doc-rail__title">
          {t('DocHistory.title')}
        </h2>
        <Button tone="text" size="compact" onClick={onClose}>
          {t('DocHistory.close')}
        </Button>
      </div>

      {versions.isPending ? (
        <LoadingRegion label={t('DocHistory.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}
      {versions.isError ? (
        <InlineAlert tone="danger" title={t('DocHistory.loadError')} live>
          {describeError(versions.error)}
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ol className="tm-doc-history__list" aria-label={t('DocHistory.listAria')}>
          {rows.map((version) => {
            const isCurrent = version.versionNo === currentNo;
            const selected = isCurrent ? !picked : version.versionNo === selectedVersionNo;
            const who = nameOf(version.editedByUserId);
            return (
              <li key={version.id}>
                <button
                  type="button"
                  className={`tm-doc-history__row${selected ? ' is-selected' : ''}`}
                  aria-pressed={selected}
                  onClick={() => onSelect(isCurrent ? null : version.versionNo)}
                >
                  <span className="tm-doc-history__name">
                    {isCurrent
                      ? t('DocHistory.current')
                      : t('DocHistory.version').replace('{n}', String(version.versionNo))}
                  </span>
                  <span className="tm-doc-history__meta">
                    {who !== '' ? `${who} · ` : ''}
                    <time dateTime={version.createdAt}>
                      {formatWhen(version.createdAt, locale)}
                    </time>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}

      {restore.isError ? (
        <InlineAlert tone="danger" title={t('DocHistory.restoreError')} live>
          {describeError(restore.error)}
        </InlineAlert>
      ) : null}

      {picked ? (
        <div className="tm-doc-history__actions">
          <Button
            tone="ink"
            size="compact"
            loading={restore.isPending}
            onClick={() => restore.mutate(selectedVersionNo as number)}
          >
            {t('DocHistory.restore').replace('{n}', String(selectedVersionNo))}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export interface DocVersionPreviewProps {
  organizationSlug: string;
  documentId: string;
  client: ApiClient;
  versionNo: number;
  people?: readonly DocumentPerson[];
}

/** The selected version, read-only in the sheet, under frame 9's "Viewing version N" strip. */
export function DocVersionPreview({
  organizationSlug,
  documentId,
  client,
  versionNo,
  people = [],
}: DocVersionPreviewProps) {
  const t = useT();
  const locale = useActiveLocale();
  const describeError = useDescribeApiError();
  const version = useQuery({
    queryKey: ['document-version', organizationSlug, documentId, versionNo],
    queryFn: () => getDocumentVersion(client, organizationSlug, documentId, versionNo),
  });

  if (version.isPending) {
    return (
      <LoadingRegion label={t('DocHistory.loading')}>
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }
  if (version.isError) {
    return (
      <InlineAlert tone="danger" title={t('DocHistory.loadError')} live>
        {describeError(version.error)}
      </InlineAlert>
    );
  }
  const data = version.data;
  const who = people.find((person) => person.userId === data.editedByUserId)?.displayName;
  return (
    <div className="tm-doc-history__preview">
      <p className="tm-doc-history__strip" role="status">
        <span aria-hidden="true">↻</span>
        {t('DocHistory.viewing').replace('{n}', String(data.versionNo))}
        {who ? ` · ${who}` : ''} · {formatWhen(data.createdAt, locale)} — {t('DocHistory.readOnly')}
      </p>
      {formatOf(data) === 'html' ? (
        <DocBodyView html={data.body} />
      ) : (
        <DocMarkdown body={data.body} />
      )}
    </div>
  );
}

/** "today 10:42", "28 Oct 09:12". */
function formatWhen(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameDay = at.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(
    tagFor(locale),
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false },
  ).format(at);
}
