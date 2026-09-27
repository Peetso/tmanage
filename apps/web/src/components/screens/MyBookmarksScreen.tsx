'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listDocBookmarks } from '../../lib/api/doc-bookmarks';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MyBookmarksScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **DOC bookmarks / favorites (x242).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs — the caller's private favorites list. It reads the
 * caller's own bookmarks (newest first), each projected to a document the caller can still read; a
 * document the caller has since lost access to is dropped by the API, so no title leaks here.
 *
 * ## What it does, and what it cannot
 *
 * - **The list is the caller's own.** The API scopes it to the acting membership; there is no view of
 *   another member's favorites.
 * - **Bookmarking happens elsewhere.** This screen only lists; the per-document `BookmarkToggle` adds
 *   and removes, and invalidates this list on success.
 */
export function MyBookmarksScreen({
  organizationSlug,
  organizationName,
  client,
}: MyBookmarksScreenProps) {
  const api = client ?? browserApiClient();

  const bookmarks = useQuery({
    queryKey: ['doc-bookmarks', organizationSlug],
    queryFn: () => listDocBookmarks(api, organizationSlug),
  });

  const rows = bookmarks.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="docs"
      title="Bookmarked documents"
      description="The documents you have bookmarked, newest first. Only documents you can still read appear here."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-bookmarks-heading">
        <h2 id="tm-bookmarks-heading" className="tm-eyebrow">
          Your bookmarks
        </h2>

        {bookmarks.isError ? (
          <InlineAlert tone="danger" title="Could not load your bookmarks" live>
            {describeError(bookmarks.error)}
          </InlineAlert>
        ) : null}

        {bookmarks.isPending ? (
          <LoadingRegion label="Loading your bookmarks.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!bookmarks.isPending && !bookmarks.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title="No bookmarks yet">
            Bookmark a document to keep it here. Use the bookmark control beside a document to add
            it.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <div
            className="tm-table-scroll"
            // A scrollable region must be focusable or a keyboard cannot reach its overflow columns
            // (WCAG 2.2 2.1.1), matching the other screens' tables.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            role="region"
            aria-label="Bookmarked documents"
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                Your bookmarked documents, newest first, {rows.length} shown.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Bookmarked at</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((bookmark) => (
                  <tr key={bookmark.id}>
                    <th scope="row" className="tm-table__title">
                      {bookmark.title}
                    </th>
                    <td>{new Date(bookmark.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
