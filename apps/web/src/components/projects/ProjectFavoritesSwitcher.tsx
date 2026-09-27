'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { listProjectFavorites } from '../../lib/api/project-favorites';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ProjectFavoritesSwitcherProps {
  organizationSlug: string;
  client?: ApiClient;
}

/**
 * **PROJ project favorites (x268).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §"Member home" — the compact project switcher. It reads
 * the caller's own favorites (newest first), each projected to a project the caller can still read; a
 * project the caller has since lost access to is dropped by the API, so no name leaks here.
 *
 * ## What it does, and what it cannot
 *
 * - **The list is the caller's own.** The API scopes it to the acting membership; there is no view of
 *   another member's favorites.
 * - **Favoriting happens elsewhere.** This switcher only lists; the per-project `FavoriteStar` stars
 *   and unstars, and invalidates this list on success.
 */
export function ProjectFavoritesSwitcher({
  organizationSlug,
  client,
}: ProjectFavoritesSwitcherProps) {
  const api = client ?? browserApiClient();

  const favorites = useQuery({
    queryKey: ['project-favorites', organizationSlug],
    queryFn: () => listProjectFavorites(api, organizationSlug),
  });

  const rows = favorites.data ?? [];

  return (
    <nav className="tm-panel tm-stack" aria-labelledby="tm-project-favorites-heading">
      <h2 id="tm-project-favorites-heading" className="tm-eyebrow">
        Favorite projects
      </h2>

      {favorites.isError ? (
        <InlineAlert tone="danger" title="Could not load your favorite projects" live>
          {describeError(favorites.error)}
        </InlineAlert>
      ) : null}

      {favorites.isPending ? (
        <LoadingRegion label="Loading your favorite projects.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {!favorites.isPending && !favorites.isError && rows.length === 0 ? (
        <InlineAlert tone="neutral" title="No favorite projects yet">
          Favorite a project to keep it on your switcher. Use the star beside a project to add it.
        </InlineAlert>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-list" aria-label="Favorite projects, newest first">
          {rows.map((favorite) => (
            <li key={favorite.id}>
              <a
                className="tm-list__link"
                href={`/organizations/${encodeURIComponent(organizationSlug)}/projects/${encodeURIComponent(favorite.projectId)}`}
              >
                {favorite.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
