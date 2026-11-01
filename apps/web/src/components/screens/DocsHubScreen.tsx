'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { AudienceBadge } from '../docs/DocumentAudience';
import { useCreateBlankDocument } from '../docs/DocsSidebar';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { listRecentDocuments } from '../../lib/api/documents';
import type { DocumentListScope } from '../../lib/api/documents';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { compactUnit } from '../../lib/i18n/compact-time';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface DocsHubScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Preselect a project — how a project screen hands off to its documents. */
  initialProjectId?: string;
  client?: ApiClient;
}

type HubTab = 'recent' | 'project' | 'favourites';

/**
 * **DOC-01 Docs hub.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs DOC-01: "Docs hub — recent, project knowledge,
 * favorites." Three lists over one endpoint (`recent-documents`), newest update first:
 *
 * - **Recent** — every document the caller may read across the studio's projects.
 * - **Project knowledge** — one project's documents; the project capsules switch between them.
 * - **Favourites** — the caller's own bookmarks (`doc_bookmarks`).
 *
 * Each row shows its project and its **audience** (internal, or published to the project's client
 * people with how many there are). Documents in projects the caller cannot read are never listed;
 * the API returns only how many there were, drawn as DOC-01's quiet "in a space you cannot read" row.
 * "Templates" goes to the template gallery. A15: "New doc" creates a blank document in the chosen
 * project (or the first one) and opens it in the editor (383:3806).
 */
export function DocsHubScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: DocsHubScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const [tab, setTab] = useState<HubTab>(initialProjectId ? 'project' : 'recent');
  const [chosenId, setProjectId] = useState<string>(initialProjectId ?? '');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
    enabled: tab === 'project',
  });

  const available = projects.data ?? [];
  const projectId = chosenId !== '' ? chosenId : (available[0]?.id ?? '');

  const scope: DocumentListScope | null =
    tab === 'recent'
      ? { kind: 'recent' }
      : tab === 'favourites'
        ? { kind: 'favourites' }
        : projectId !== ''
          ? { kind: 'project', projectId }
          : null;

  const documents = useQuery({
    queryKey: ['recent-documents', organizationSlug, tab, tab === 'project' ? projectId : ''],
    queryFn: () => listRecentDocuments(api, organizationSlug, scope ?? { kind: 'recent' }),
    enabled: scope !== null,
  });

  const createBlank = useCreateBlankDocument(
    api,
    organizationSlug,
    tab === 'project' && projectId !== '' ? projectId : undefined,
  );

  const rows = documents.data?.documents ?? [];
  const hidden = documents.data?.hiddenCount ?? 0;

  const tabButton = (id: HubTab, label: string) => (
    <button type="button" className="tm-chip" aria-pressed={tab === id} onClick={() => setTab(id)}>
      {label}
    </button>
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      eyebrow={t('DocsHubScreen.eyebrow')}
      title={t('DocsHubScreen.title')}
      actions={
        <button
          type="button"
          className="tm-dx-new"
          disabled={createBlank.isPending}
          onClick={() => createBlank.mutate()}
        >
          <span className="tm-dx-new__orb" aria-hidden="true">
            +
          </span>
          {t('DocsHubScreen.newDoc')}
        </button>
      }
    >
      <div className="tm-dx">
        <div className="tm-dx-chips" role="group" aria-label={t('DocsHubScreen.documentsAria')}>
          {tabButton('recent', t('DocsHubScreen.tabRecent'))}
          {tabButton('project', t('DocsHubScreen.tabProject'))}
          <Link className="tm-chip" href={`/${organizationSlug}/docs/templates`}>
            {t('DocsHubScreen.templates')}
          </Link>
          {tabButton('favourites', t('DocsHubScreen.tabFavourites'))}
          <span className="tm-dx-chips__sep" aria-hidden="true" />
          <Link className="tm-chip" href={`/${organizationSlug}/docs/collections`}>
            {t('DocsHubScreen.collections')}
          </Link>
          <Link className="tm-chip" href={`/${organizationSlug}/decisions`}>
            {t('DocsHubScreen.decisions')}
          </Link>
        </div>

        {tab === 'project' && available.length > 0 ? (
          <div className="tm-dx-chips" role="group" aria-label={t('DocsHubScreen.projectAria')}>
            {available.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="tm-chip"
                aria-pressed={candidate.id === projectId}
                onClick={() => setProjectId(candidate.id)}
              >
                {candidate.name}
              </button>
            ))}
          </div>
        ) : null}

        {createBlank.isError ? (
          <InlineAlert tone="danger" title={t('DocsHubScreen.loadDocsError')} live>
            {describeError(createBlank.error)}
          </InlineAlert>
        ) : null}

        {tab === 'project' && projects.isError ? (
          <InlineAlert tone="danger" title={t('DocsHubScreen.loadProjectsError')} live>
            {describeError(projects.error)}
          </InlineAlert>
        ) : null}

        {tab === 'project' && projects.isSuccess && available.length === 0 && chosenId === '' ? (
          <div className="tm-dx-empty">
            <p className="tm-dx-empty__title">{t('DocsHubScreen.emptyProjectsTitle')}</p>
            <p className="tm-dx-empty__body">{t('DocsHubScreen.emptyProjectsBody')}</p>
          </div>
        ) : null}

        {documents.isError ? (
          <InlineAlert tone="danger" title={t('DocsHubScreen.loadDocsError')} live>
            {describeError(documents.error)}
          </InlineAlert>
        ) : null}

        {scope !== null && documents.isPending ? (
          <LoadingRegion label={t('DocsHubScreen.loadingDocs')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {documents.isSuccess && rows.length === 0 && hidden === 0 ? (
          <div className="tm-dx-empty">
            <p className="tm-dx-empty__title">
              {tab === 'favourites'
                ? t('DocsHubScreen.noFavouritesTitle')
                : t('DocsHubScreen.noDocsTitle')}
            </p>
            <p className="tm-dx-empty__body">
              {tab === 'favourites'
                ? t('DocsHubScreen.noFavouritesBody')
                : t('DocsHubScreen.noDocsBody')}
            </p>
          </div>
        ) : null}

        {documents.isSuccess && (rows.length > 0 || hidden > 0) ? (
          <div
            className="tm-dx-table-card"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow
            // columns (WCAG 2.2 2.1.1), matching the work screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label={t('DocsHubScreen.tableAria')}
          >
            <table className="tm-dx-table">
              <caption className="tm-visually-hidden">
                {t('DocsHubScreen.captionPrefix')} {rows.length} {t('DocsHubScreen.captionSuffix')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('DocsHubScreen.thDocument')}</th>
                  <th scope="col">{t('DocsHubScreen.thProject')}</th>
                  <th scope="col">{t('DocsHubScreen.thAudience')}</th>
                  <th scope="col" className="tm-dx-table__end">
                    {t('DocsHubScreen.thUpdated')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((document, index) => (
                  <tr key={document.id} {...(index === 0 ? { 'data-current': 'true' } : {})}>
                    <th scope="row" className="tm-dx-table__title">
                      <Link href={`/${organizationSlug}/docs/${document.id}`}>
                        {document.title}
                      </Link>
                    </th>
                    <td className="tm-dx-table__quiet">{document.projectName}</td>
                    <td>
                      <AudienceBadge
                        audience={document.audience}
                        clientCount={document.clientAudienceCount}
                      />
                    </td>
                    <td className="tm-dx-table__end">
                      <time
                        className="tm-dx-table__mono"
                        dateTime={document.updatedAt}
                        title={formatInstant(document.updatedAt)}
                      >
                        {formatAge(document.updatedAt)}
                      </time>
                    </td>
                  </tr>
                ))}
                {hidden > 0 ? (
                  <tr data-state="hidden">
                    <th scope="row" className="tm-dx-table__hidden">
                      <span className="tm-dx-table__hidden-orb" aria-hidden="true" />
                      {hidden === 1
                        ? t('DocsHubScreen.hiddenOne')
                        : `${hidden} ${t('DocsHubScreen.hiddenManySuffix')}`}
                    </th>
                    <td className="tm-dx-table__quiet">—</td>
                    <td className="tm-dx-table__quiet">—</td>
                    <td className="tm-dx-table__end tm-dx-table__mono">—</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

/** DOC-01's compact age column: "26m", "2d", "2w". An unparseable value is shown verbatim. */
function formatAge(iso: string): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return compactUnit(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return compactUnit(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days < 14) return compactUnit(days, 'day');
  const weeks = Math.round(days / 7);
  if (weeks < 9) return compactUnit(weeks, 'week');
  return formatInstant(iso);
}
