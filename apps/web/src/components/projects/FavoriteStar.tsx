'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import {
  addProjectFavorite,
  getProjectFavoriteStatus,
  removeProjectFavorite,
} from '../../lib/api/project-favorites';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface FavoriteStarProps {
  organizationSlug: string;
  projectId: string;
  client?: ApiClient;
}

/**
 * **PROJ project favorites (x268).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §"Member home" — the per-project star that sits beside a
 * project. It reads the caller's current favorite status and toggles it: PUT to star (idempotent),
 * DELETE to unstar. On success it invalidates the caller's favorites list so the project switcher
 * reflects the change without a manual refresh.
 *
 * The control is `aria-pressed` so a screen reader announces the favorite state, and it is disabled
 * while its own mutation is in flight.
 */
export function FavoriteStar({ organizationSlug, projectId, client }: FavoriteStarProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['project-favorite', organizationSlug, projectId],
    queryFn: () => getProjectFavoriteStatus(api, organizationSlug, projectId),
  });

  const favorited = status.data ?? false;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['project-favorite', organizationSlug, projectId],
      }),
      queryClient.invalidateQueries({ queryKey: ['project-favorites', organizationSlug] }),
    ]);
  };

  const toggle = useMutation({
    mutationFn: async () => {
      if (favorited) {
        await removeProjectFavorite(api, organizationSlug, projectId);
      } else {
        await addProjectFavorite(api, organizationSlug, projectId);
      }
    },
    onSuccess: invalidate,
  });

  return (
    <div className="tm-stack">
      <Button
        type="button"
        tone={favorited ? 'ink' : 'outline'}
        size="accessible"
        aria-pressed={favorited}
        loading={toggle.isPending}
        loadingLabel={favorited ? t('FavoriteStar.removing') : t('FavoriteStar.saving')}
        disabled={status.isPending}
        onClick={() => toggle.mutate()}
      >
        {favorited ? t('FavoriteStar.favorited') : t('FavoriteStar.favorite')}
      </Button>

      {toggle.isError ? (
        <InlineAlert tone="danger" title={t('FavoriteStar.errorTitle')} live>
          {describeError(toggle.error, t)}
        </InlineAlert>
      ) : null}
    </div>
  );
}

function describeError(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('FavoriteStar.apiNoAnswer');
  return t('FavoriteStar.genericError');
}
