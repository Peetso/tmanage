'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/docs.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjects } from '../../lib/api/projects';
import { listDocuments } from '../../lib/api/documents';
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

/**
 * **DOC-01 Docs hub.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs DOC-01: "Docs hub — recent, project knowledge,
 * favorites." What is real today is **project knowledge**: x91's document read/write API lists
 * one project's documents at a time (it requires a `projectId` and never lists a whole tenant's
 * documents), so the hub chooses a project and shows that project's documents, most recent first.
 *
 * ## What it draws, and what it cannot
 *
 * - **Project knowledge** — the documents of the chosen project, in reverse creation order so the
 *   newest sits at the top. The API returns them oldest-first (keyset on the UUIDv7 id); the
 *   screen reverses that view for reading, it does not re-sort by a field the server did not order
 *   by.
 * - **Recent across all projects** and **favorites** are the other two facets the plan names.
 *   Neither has an endpoint or a table yet (a favorite is per-user state DOC-04/DEC-01 territory),
 *   so this slice does not fabricate them — the same honesty `WorkTimelineScreen` applies to
 *   baseline/forecast columns that have no data behind them.
 *
 * Documents are per-project by definition and there is no "all projects at once" read, so the hub
 * opens on the first project the caller can see (or the one handed in) and the project capsules
 * switch between them.
 *
 * Opening a document is a link to the read screen (DOC-03 read side); "New doc" goes to the
 * template gallery, where a document is created from a template.
 */
export function DocsHubScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: DocsHubScreenProps) {
  const api = client ?? browserApiClient();
  const [chosenId, setProjectId] = useState<string>(initialProjectId ?? '');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  // Documents are per project, so the hub opens on the first project the caller can see when no
  // project was handed in — the hub is never an empty chooser when there is knowledge to show.
  const available = projects.data ?? [];
  const projectId = chosenId !== '' ? chosenId : (available[0]?.id ?? '');
  const project = available.find((candidate) => candidate.id === projectId) ?? null;

  const documents = useQuery({
    queryKey: ['documents', organizationSlug, projectId],
    queryFn: () => listDocuments(api, organizationSlug, projectId),
    enabled: projectId !== '',
  });

  // Newest first for reading. The server ordered by id ascending (creation order); reversing a
  // copy of that view is presentation, not a competing sort on a field the API did not order by.
  const rows = useMemo(
    () => (documents.data ? [...documents.data].reverse() : []),
    [documents.data],
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
        <div className="tm-dx-chips">
          {available.length > 0 ? (
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
          {available.length > 0 ? <span className="tm-dx-chips__sep" aria-hidden="true" /> : null}
          <Link className="tm-chip" href={`/${organizationSlug}/docs/templates`}>
            Templates
          </Link>
          <Link className="tm-chip" href={`/${organizationSlug}/docs/collections`}>
            Collections
          </Link>
          <Link className="tm-chip" href={`/${organizationSlug}/decisions`}>
            Decisions
          </Link>
        </div>

        {projects.isError ? (
          <InlineAlert tone="danger" title="Could not load your projects" live>
            {describeError(projects.error)}
          </InlineAlert>
        ) : null}

        {!projects.isPending && !projects.isError && available.length === 0 && chosenId === '' ? (
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

        {projectId !== '' && documents.isPending ? (
          <LoadingRegion label="Loading the documents.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {projectId !== '' && !documents.isPending && !documents.isError && rows.length === 0 ? (
          <div className="tm-dx-empty">
            <p className="tm-dx-empty__title">No documents yet</p>
            <p className="tm-dx-empty__body">
              This project has no documents you can see. Start one from a template.
            </p>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-dx-table-card"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow
            // columns (WCAG 2.2 2.1.1), matching the work screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Project documents"
          >
            <table className="tm-dx-table">
              <caption className="tm-visually-hidden">
                Documents in this project, newest first, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Project</th>
                  <th scope="col">Created</th>
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
                    <td className="tm-dx-table__quiet">{project?.name ?? ''}</td>
                    <td className="tm-dx-table__quiet">{formatInstant(document.createdAt)}</td>
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
