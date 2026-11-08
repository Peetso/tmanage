'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { DocumentExportButton } from './DocumentExportButton';
import { DocumentCommentsPanel } from './DocumentCommentsPanel';
import { DocumentPublishBar } from '../docs/DocumentAudience';
import { DocMarkdown } from '../docs/DocMarkdown';
import { DocBodyView } from '../docs/editor/DocBodyView';
import type { AnchorState, CommentAnchor } from '../docs/editor/comment-reanchor';
import { listDocumentComments } from '../../lib/api/document-comments';
import { DocHistoryPanel, DocVersionPreview } from '../docs/DocHistoryPanel';
import { tagFor } from '../docs/doc-markdown';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDocument, getDocumentSharing } from '../../lib/api/documents';
import { listProjects } from '../../lib/api/projects';
import { ApiRequestError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import { useRecordRecentItem } from '../../lib/use-record-recent-item';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface DocumentViewScreenProps {
  organizationSlug: string;
  organizationName: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * **DOC-03 Document view (read side).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs DOC-03: "Document view/history." This is the read
 * side — a document's title, body and metadata, read-only. History (versions), compare/restore
 * and the client projection are the write/history half, deferred (DOC-03 write, DOC-02 editor).
 *
 * ## Not-found is the interesting state (Known trap)
 *
 * The route names the document by id. The API resolves that id **tenant-scoped before the
 * relation check** (x91), so an id in another tenant, a document in a project the caller is not a
 * member of, and an id that simply does not exist all answer the **same** 404 — never a 403 that
 * would confirm the document exists, and never a 500. This screen renders that 404 as a plain
 * "not found" state and does not try to tell the three apart, which is exactly what keeps a
 * non-member from probing which documents a studio keeps. Any other failure is shown as an error,
 * not as not-found, so a transient outage is not misread as "deleted".
 */
export function DocumentViewScreen({
  organizationSlug,
  organizationName,
  documentId,
  client,
}: DocumentViewScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();

  const document = useQuery({
    queryKey: ['document', organizationSlug, documentId],
    queryFn: () => getDocument(api, organizationSlug, documentId),
  });

  useRecordRecentItem({
    organizationSlug,
    objectType: 'document',
    objectId: documentId,
    enabled: document.isSuccess,
    client,
  });

  // The sheet's eyebrow names the document's project. The project list is the one the hub and the
  // project screens already read (same query key, so it is usually cached).
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: async () => (await listProjects(api, organizationSlug)) ?? [],
  });

  // The sheet's byline names the author and the collaborator count; the top bar's publish cluster
  // reads the same query key, so this is one request.
  const sharing = useQuery({
    queryKey: ['document-sharing', organizationSlug, documentId],
    queryFn: () => getDocumentSharing(api, organizationSlug, documentId),
    enabled: document.isSuccess,
  });
  const people = sharing.data?.collaborators ?? [];

  // R5: the anchor shared by the body marks and the comments rail, and the history panel state.
  const [activeAnchorId, setActiveAnchorId] = useState<string | null>(null);
  // 53-11: the rail's own query (same key, one request) feeds the body's re-anchoring, and the
  // body reports back which threads moved to the nearest text and which lost theirs.
  const threadComments = useQuery({
    queryKey: ['document-comments', organizationSlug, documentId],
    queryFn: () => listDocumentComments(api, organizationSlug, documentId),
    enabled: document.isSuccess,
  });
  const anchors = useMemo<readonly CommentAnchor[]>(() => {
    const byId = new Map<string, string | null>();
    for (const row of threadComments.data ?? []) {
      if (row.anchorId && !byId.get(row.anchorId)) byId.set(row.anchorId, row.anchorQuote);
    }
    return [...byId.entries()].map(([anchorId, quote]) => ({ anchorId, quote }));
  }, [threadComments.data]);
  const [anchorStates, setAnchorStates] = useState<Readonly<Record<string, AnchorState>>>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewVersionNo, setPreviewVersionNo] = useState<number | null>(null);

  // A 404 is the not-found state; every other refusal is an error. The API answers unknown,
  // cross-tenant and non-member ids all with 404, so this one branch covers the whole trap.
  const notFound = useMemo(
    () =>
      document.isError &&
      document.error instanceof ApiRequestError &&
      document.error.status === 404,
    [document.isError, document.error],
  );

  const data = document.data;
  const projectName = data
    ? ((projects.data ?? []).find((project) => project.id === data.projectId)?.name ?? null)
    : null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      eyebrow={t('DocumentViewScreen.eyebrow')}
      title={data ? data.title : t('DocumentViewScreen.titleFallback')}
      actions={
        <div className="tm-dx-topbar">
          <Link className="tm-dx-back" href={`/${organizationSlug}/docs`}>
            <span className="tm-dx-back__orb" aria-hidden="true">
              ←
            </span>
            {t('DocumentViewScreen.backToDocs')}
          </Link>
          {data ? (
            <span className="tm-dx-stamp">
              {t('DocumentViewScreen.saved')} {formatClock(data.updatedAt, locale)}
            </span>
          ) : null}
          {data ? (
            <div className="tm-dx-topbar__end">
              <DocumentPublishBar
                organizationSlug={organizationSlug}
                documentId={documentId}
                client={api}
                documentTitle={data.title}
                projectName={projectName ?? ''}
              />
              <nav className="tm-segmented" aria-label={t('DocumentViewScreen.documentViewsAria')}>
                <Link href={`/${organizationSlug}/docs/${documentId}`} aria-current="page">
                  {t('DocumentViewScreen.read')}
                </Link>
                <Link href={`/${organizationSlug}/docs/${documentId}/edit`}>
                  {t('DocumentViewScreen.editAndHistory')}
                </Link>
              </nav>
              {/* DOC export (x131): a Markdown download of the current version, shown once the
                  document has loaded so the control never links to an id the caller cannot read. */}
              <DocumentExportButton organizationSlug={organizationSlug} documentId={documentId} />
              <Button
                tone="outline"
                aria-pressed={historyOpen}
                onClick={() => {
                  setHistoryOpen((open) => !open);
                  setPreviewVersionNo(null);
                }}
              >
                {t('DocHistory.open')}
              </Button>
              <Link
                className="tm-button tm-button--ink tm-button--default"
                href={`/${organizationSlug}/docs/${documentId}/edit`}
              >
                {t('DocumentViewScreen.edit')}
              </Link>
            </div>
          ) : null}
        </div>
      }
    >
      {document.isPending ? (
        <LoadingRegion label={t('DocumentViewScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {notFound ? (
        <InlineAlert tone="neutral" title={t('DocumentViewScreen.notFoundTitle')} live>
          {t('DocumentViewScreen.notFoundBody')}
        </InlineAlert>
      ) : null}

      {document.isError && !notFound ? (
        <InlineAlert tone="danger" title={t('DocumentViewScreen.loadError')} live>
          {describeError(document.error)}
        </InlineAlert>
      ) : null}

      {data ? (
        <div className="tm-dx-doc">
          <div className="tm-dx-doc__stage">
            <article className="tm-dx-sheet" aria-labelledby="tm-document-body">
              <header className="tm-dx-sheet__head">
                <p className="tm-dx-sheet__eyebrow" id="tm-document-body">
                  {projectName
                    ? `${t('DocumentViewScreen.docProjectPrefix')}${projectName}`
                    : t('DocumentViewScreen.docFallback')}
                </p>
                {/* The shell's h1 carries the title for assistive technology; this is its
                    on-paper rendering, so it is hidden from the accessibility tree. */}
                <p className="tm-dx-sheet__title" aria-hidden="true">
                  {data.title}
                </p>
                <p className="tm-dx-sheet__meta">
                  {people[0] ? `${people[0].displayName} · ` : ''}
                  {t('DocumentViewScreen.updated')}{' '}
                  <time dateTime={data.updatedAt} title={formatInstant(data.updatedAt)}>
                    {formatRelative(data.updatedAt, locale)}
                  </time>
                  {people.length > 0
                    ? ` · ${people.length} ${
                        people.length === 1
                          ? t('DocumentViewScreen.collaborator')
                          : t('DocumentViewScreen.collaborators')
                      }`
                    : ''}
                </p>
              </header>
              <hr className="tm-dx-sheet__rule" />
              {historyOpen && previewVersionNo !== null ? (
                <DocVersionPreview
                  organizationSlug={organizationSlug}
                  documentId={documentId}
                  client={api}
                  versionNo={previewVersionNo}
                  people={people}
                />
              ) : (
                // C15: render the current body only when no older version is previewed — the
                // body's `display: flex` beat the `hidden` attribute, so both texts showed.
                <div className="tm-dx-sheet__body">
                  {/* R5: an `html` body renders through the read-only Tiptap schema (unknown nodes
                    drop, never injected HTML); comment anchors talk to the rail both ways. */}
                  {(data as { bodyFormat?: 'markdown' | 'html' }).bodyFormat === 'html' ? (
                    <DocBodyView
                      html={data.body}
                      activeAnchorId={activeAnchorId}
                      onCommentClick={setActiveAnchorId}
                      anchors={anchors}
                      onAnchorStates={setAnchorStates}
                    />
                  ) : (
                    /* The body's Markdown as headings, lists, bold and safe links (live test
                    2026-10-31: it showed raw "#" and "**"). React escapes every string; no HTML
                    is parsed. */
                    <DocMarkdown
                      body={data.body}
                      doneLabel={tOr('DocumentViewScreen.checkDone', 'Done')}
                      openLabel={tOr('DocumentViewScreen.checkOpen', 'Not done')}
                    />
                  )}
                </div>
              )}
            </article>
          </div>

          {/* Docs "collaboration later" (x132) — the document's comments, read/add, in the
              edge column DOC-02 draws beside the sheet. */}
          {historyOpen ? (
            <DocHistoryPanel
              organizationSlug={organizationSlug}
              documentId={documentId}
              client={api}
              people={people}
              selectedVersionNo={previewVersionNo}
              onSelect={setPreviewVersionNo}
              onClose={() => {
                setHistoryOpen(false);
                setPreviewVersionNo(null);
              }}
            />
          ) : (
            <DocumentCommentsPanel
              organizationSlug={organizationSlug}
              documentId={documentId}
              client={api}
              activeAnchorId={activeAnchorId}
              onCommentClick={setActiveAnchorId}
              anchorStates={anchorStates}
            />
          )}
        </div>
      ) : null}
    </AppShell>
  );
}

/**
 * The top bar's "SAVED 11:26" stamp: the 24-hour time of day, or the date when not today — the
 * same clock the editor's version list uses (live test 2026-10-31 saw "11:34 PM" beside "23:33").
 */
function formatClock(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameDay = at.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(
    tagFor(locale),
    sameDay
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { day: 'numeric', month: 'short' },
  ).format(at);
}

/** "26 minutes ago", "3 days ago" — the sheet byline's age, in the active locale (C2). */
export function formatRelative(iso: string, locale: string): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(tagFor(locale), { numeric: 'auto' });
  const steps: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'minute');
}
