'use client';

import { useContext, useState } from 'react';
import Link from 'next/link';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { createDocument, listRecentDocuments } from '../../lib/api/documents';
import { listProjects } from '../../lib/api/projects';
import { useTOr } from '../../lib/i18n/use-t-or';
import './docs-shell.css';

/**
 * A15. "New doc": create a blank document in a project and open it in the editor.
 *
 * The project is the one the caller names (the editor's own project, the hub's chosen one), else
 * the first project the caller can see. The title is the catalog's "Untitled doc"; the body is the
 * blank marker `createDocument` sends, which the editor shows as empty with its placeholder.
 */
export function useCreateBlankDocument(
  api: ApiClient,
  organizationSlug: string,
  projectId?: string,
) {
  const tOr = useTOr();
  const router = useContext(AppRouterContext);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      let target = projectId ?? '';
      if (target === '') {
        const projects = await listProjects(api, organizationSlug);
        target = projects[0]?.id ?? '';
      }
      if (target === '') throw new Error(tOr('DocsSidebar.noProject', 'Create a project first.'));
      return createDocument(api, organizationSlug, {
        projectId: target,
        title: tOr('DocsSidebar.untitled', 'Untitled doc'),
      });
    },
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: ['recent-documents', organizationSlug] });
      const href = `/${organizationSlug}/docs/${document.id}/edit`;
      if (router) router.push(href);
      else window.location.assign(href);
    },
  });
}

export interface DocsSidebarProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** The document on screen, inked in RECENT DOCS. */
  readonly activeDocumentId?: string;
  /** Where "New doc" creates the document; the first visible project when absent. */
  readonly projectId?: string;
}

/**
 * The Slack-like docs column (383:3806): a find field, the black "New doc" button and RECENT
 * DOCS — the documents the caller may read across the studio's projects, newest update first,
 * from `recent-documents` (the hub's own read).
 */
export function DocsSidebar({
  api,
  organizationSlug,
  activeDocumentId,
  projectId,
}: DocsSidebarProps) {
  const tOr = useTOr();
  const [find, setFind] = useState('');
  const create = useCreateBlankDocument(api, organizationSlug, projectId);

  const recent = useQuery({
    queryKey: ['recent-documents', organizationSlug, 'recent', ''],
    queryFn: () => listRecentDocuments(api, organizationSlug, { kind: 'recent' }),
  });

  const needle = find.trim().toLocaleLowerCase();
  const rows = (recent.data?.documents ?? []).filter(
    (row) => needle === '' || row.title.toLocaleLowerCase().includes(needle),
  );

  return (
    <div className="tm-docside">
      <label className="tm-docside__find">
        <span className="tm-docside__find-glyph" aria-hidden="true">
          ⌕
        </span>
        <span className="tm-visually-hidden">
          {tOr('DocsSidebar.findLabel', 'Find a channel or person')}
        </span>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder={tOr('DocsSidebar.findPlaceholder', 'Find a channel or person')}
        />
        <kbd className="tm-docside__kbd" aria-hidden="true">
          ⌘K
        </kbd>
      </label>

      <button
        type="button"
        className="tm-docside__new"
        disabled={create.isPending}
        onClick={() => create.mutate()}
      >
        {tOr('DocsSidebar.newDoc', 'New doc')}
      </button>
      {create.isError ? (
        <p className="tm-docside__empty" role="alert">
          {create.error instanceof Error
            ? create.error.message
            : tOr('DocsSidebar.createError', 'Could not create the document.')}
        </p>
      ) : null}

      <section className="tm-docside__group" aria-labelledby="tm-docside-recent">
        <h2 id="tm-docside-recent" className="tm-docside__eyebrow">
          {tOr('DocsSidebar.recentDocs', 'Recent docs')}
        </h2>
        <ul className="tm-docside__list">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                className="tm-docside__row"
                href={`/${organizationSlug}/docs/${row.id}/edit`}
                {...(row.id === activeDocumentId ? { 'aria-current': 'page' as const } : {})}
              >
                <span className="tm-docside__row-glyph" aria-hidden="true">
                  ◫
                </span>
                <span>{row.title}</span>
              </Link>
            </li>
          ))}
        </ul>
        {recent.isSuccess && rows.length === 0 ? (
          <p className="tm-docside__empty">{tOr('DocsSidebar.noDocs', 'No documents yet')}</p>
        ) : null}
      </section>
    </div>
  );
}
