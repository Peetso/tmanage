'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { AudienceBadge } from '../docs/DocumentAudience';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { listRecentDocuments } from '../../lib/api/documents';
import type { DocumentListScope } from '../../lib/api/documents';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { formatInstant } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';

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
 * "New doc" and "Templates" go to the template gallery, where a document is created from a template.
 */
export function DocsHubScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: DocsHubScreenProps) {
  const api = client ?? browserApiClient();
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
      eyebrow="Docs · Hub"
      title="Knowledge"
      actions={
        <Link className="tm-dx-new" href={`/${organizationSlug}/docs/templates`}>
          <span className="tm-dx-new__orb" aria-hidden="true">
            +
          </span>
          New doc
        </Link>
      }
    >
      <div className="tm-dx">
        <div className="tm-dx-chips" role="group" aria-label="Documents">
          {tabButton('recent', 'Recent')}
          {tabButton('project', 'Project knowledge')}
          <Link className="tm-chip" href={`/${organizationSlug}/docs/templates`}>
            Templates
          </Link>
          {tabButton('favourites', 'Favourites')}
          <span className="tm-dx-chips__sep" aria-hidden="true" />
          <Link className="tm-chip" href={`/${organizationSlug}/docs/collections`}>
            Collections
          </Link>
          <Link className="tm-chip" href={`/${organizationSlug}/decisions`}>
            Decisions
          </Link>
        </div>

        {tab === 'project' && available.length > 0 ? (
          <div className="tm-dx-chips" role="group" aria-label="Project">
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

        {tab === 'project' && projects.isError ? (
          <InlineAlert tone="danger" title="Could not load your projects" live>
            {describeError(projects.error)}
          </InlineAlert>
        ) : null}

        {tab === 'project' && projects.isSuccess && available.length === 0 && chosenId === '' ? (
          <div className="tm-dx-empty">
            <p className="tm-dx-empty__title">No projects yet</p>
            <p className="tm-dx-empty__body">
              Documents belong to a project. Once a project exists, its knowledge appears here.
            </p>
          </div>
        ) : null}

        {documents.isError ? (
          <InlineAlert tone="danger" title="Could not load the documents" live>
            {describeError(documents.error)}
          </InlineAlert>
        ) : null}

        {scope !== null && documents.isPending ? (
          <LoadingRegion label="Loading the documents.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {documents.isSuccess && rows.length === 0 && hidden === 0 ? (
          <div className="tm-dx-empty">
            <p className="tm-dx-empty__title">
              {tab === 'favourites' ? 'No favourites yet' : 'No documents yet'}
            </p>
            <p className="tm-dx-empty__body">
              {tab === 'favourites'
                ? 'Bookmark a document to keep it here.'
                : 'There are no documents you can see here. Start one from a template.'}
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
            aria-label="Documents"
          >
            <table className="tm-dx-table">
              <caption className="tm-visually-hidden">
                Documents, most recently updated first, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Project</th>
                  <th scope="col">Audience</th>
                  <th scope="col" className="tm-dx-table__end">
                    Updated
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
                        ? '1 document in a space you cannot read'
                        : `${hidden} documents in spaces you cannot read`}
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
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w`;
  return formatInstant(iso);
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
