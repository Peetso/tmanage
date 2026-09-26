'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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
 * A project must be chosen before anything is fetched: documents are per-project by definition,
 * and there is no "all projects at once" read to make.
 *
 * Opening a document is a link to the read screen (DOC-03 read side); there is no editor here —
 * DOC-02 is a later slice.
 */
export function DocsHubScreen({
  organizationSlug,
  organizationName,
  initialProjectId,
  client,
}: DocsHubScreenProps) {
  const api = client ?? browserApiClient();
  const [projectId, setProjectId] = useState<string>(initialProjectId ?? '');

  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

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
      title="Docs"
      description="A project's documents, most recent first."
    >
      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-docs-filters">
        <h2 id="tm-docs-filters" className="tm-eyebrow">
          Project
        </h2>
        <fieldset className="tm-fieldset tm-stack" disabled={projects.isPending}>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-docs-project">
              Show the documents for
            </label>
            <select
              id="tm-docs-project"
              className="tm-field__control"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Choose a project…</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <span className="tm-field__hint">
            Documents belong to a project. Choose one to see its knowledge base.
          </span>
        </fieldset>
      </section>

      {projectId === '' ? (
        <InlineAlert tone="neutral" title="Choose a project">
          Pick a project above to see its documents.
        </InlineAlert>
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
        <InlineAlert tone="neutral" title="No documents yet">
          This project has no documents you can see.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <div
          className="tm-table-scroll"
          // A scrollable region must be focusable or a keyboard cannot reach its overflow
          // columns (WCAG 2.2 2.1.1), matching the work screens' tables.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          role="region"
          aria-label="Project documents"
        >
          <table className="tm-table">
            <caption className="tm-visually-hidden">
              Documents in this project, newest first, {rows.length} shown.
            </caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Created</th>
                <th scope="col">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((document) => (
                <tr key={document.id}>
                  <th scope="row" className="tm-table__title">
                    <Link href={`/${organizationSlug}/docs/${document.id}`}>{document.title}</Link>
                  </th>
                  <td>{formatInstant(document.createdAt)}</td>
                  <td>{formatInstant(document.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
