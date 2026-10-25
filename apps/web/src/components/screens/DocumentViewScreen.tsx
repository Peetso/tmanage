'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { DocumentExportButton } from './DocumentExportButton';
import { DocumentCommentsPanel } from './DocumentCommentsPanel';
import { DocumentPublishBar } from '../docs/DocumentAudience';
import { browserApiClient } from '../../lib/api/browser-client';
import { getDocument, getDocumentSharing } from '../../lib/api/documents';
import { listProjects } from '../../lib/api/projects';
import { ApiRequestError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import { useRecordRecentItem } from '../../lib/use-record-recent-item';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
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
              {t('DocumentViewScreen.saved')} {formatClock(data.updatedAt)}
            </span>
          ) : null}
          {data ? (
            <div className="tm-dx-topbar__end">
              <DocumentPublishBar
                organizationSlug={organizationSlug}
                documentId={documentId}
                client={api}
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
                    {formatRelative(data.updatedAt)}
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
              <div className="tm-dx-sheet__body">
                {toParagraphs(data.body).map((line, index) => (
                  // Plain-text body from a TEXT column: React escapes it, and each author line is
                  // its own paragraph so the reading preserves the breaks without interpreting markup.
                  <p key={index}>{line}</p>
                ))}
              </div>
            </article>
          </div>

          {/* Docs "collaboration later" (x132) — the document's comments, read/add, in the
              edge column DOC-02 draws beside the sheet. */}
          <DocumentCommentsPanel
            organizationSlug={organizationSlug}
            documentId={documentId}
            client={api}
          />
        </div>
      ) : null}
    </AppShell>
  );
}

/** The top bar's "SAVED 11:26" stamp: the local time of day, or the date when not today. */
function formatClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameDay = at.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' },
  ).format(at);
}

/** "26 minutes ago", "3 days ago" — the sheet byline's age. */
function formatRelative(iso: string): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const seconds = Math.round((at - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
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

/** Split a plain-text body into paragraphs on line breaks, dropping blank lines. */
function toParagraphs(body: string): readonly string[] {
  const lines = body.split(/\r?\n/).filter((line) => line.trim() !== '');
  return lines.length > 0 ? lines : [body];
}
