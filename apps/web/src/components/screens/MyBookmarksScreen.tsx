'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listDocBookmarks } from '../../lib/api/doc-bookmarks';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';

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
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();

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
      title={t('MyBookmarksScreen.title')}
      description={t('MyBookmarksScreen.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-bookmarks-heading">
        <h2 id="tm-bookmarks-heading" className="tm-eyebrow">
          {t('MyBookmarksScreen.yourBookmarks')}
        </h2>

        {bookmarks.isError ? (
          <InlineAlert tone="danger" title={t('MyBookmarksScreen.loadError')} live>
            {describeError(bookmarks.error)}
          </InlineAlert>
        ) : null}

        {bookmarks.isPending ? (
          <LoadingRegion label={t('MyBookmarksScreen.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {!bookmarks.isPending && !bookmarks.isError && rows.length === 0 ? (
          <InlineAlert tone="neutral" title={t('MyBookmarksScreen.emptyTitle')}>
            {t('MyBookmarksScreen.emptyBody')}
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
            aria-label={t('MyBookmarksScreen.title')}
          >
            <table className="tm-table">
              <caption className="tm-visually-hidden">
                {t('MyBookmarksScreen.captionPrefix')} {rows.length}{' '}
                {t('MyBookmarksScreen.captionShown')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('MyBookmarksScreen.colDocument')}</th>
                  <th scope="col">{t('MyBookmarksScreen.colBookmarkedAt')}</th>
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
