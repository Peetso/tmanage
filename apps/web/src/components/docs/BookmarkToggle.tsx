'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  addDocBookmark,
  getDocBookmarkStatus,
  removeDocBookmark,
} from '../../lib/api/doc-bookmarks';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface BookmarkToggleProps {
  organizationSlug: string;
  documentId: string;
  client?: ApiClient;
}

/**
 * **DOC bookmarks / favorites (x242).**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Docs — the per-document favorite control that sits beside a
 * document. It reads the caller's current bookmark status and toggles it: PUT to bookmark (idempotent),
 * DELETE to unbookmark. On success it invalidates the caller's bookmarks list so `MyBookmarksScreen`
 * reflects the change without a manual refresh.
 *
 * The control is `aria-pressed` so a screen reader announces the favorite state, and it is disabled
 * while its own mutation is in flight.
 */
export function BookmarkToggle({ organizationSlug, documentId, client }: BookmarkToggleProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const status = useQuery({
    queryKey: ['doc-bookmark', organizationSlug, documentId],
    queryFn: () => getDocBookmarkStatus(api, organizationSlug, documentId),
  });

  const bookmarked = status.data ?? false;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['doc-bookmark', organizationSlug, documentId],
      }),
      queryClient.invalidateQueries({ queryKey: ['doc-bookmarks', organizationSlug] }),
    ]);
  };

  const toggle = useMutation({
    mutationFn: async () => {
      if (bookmarked) {
        await removeDocBookmark(api, organizationSlug, documentId);
      } else {
        await addDocBookmark(api, organizationSlug, documentId);
      }
    },
    onSuccess: invalidate,
  });

  return (
    <div className="tm-stack">
      <Button
        type="button"
        tone={bookmarked ? 'ink' : 'outline'}
        size="accessible"
        aria-pressed={bookmarked}
        loading={toggle.isPending}
        loadingLabel={bookmarked ? 'Removing' : 'Saving'}
        disabled={status.isPending}
        onClick={() => toggle.mutate()}
      >
        {bookmarked ? 'Bookmarked' : 'Bookmark'}
      </Button>

      {toggle.isError ? (
        <InlineAlert tone="danger" title="Could not update the bookmark" live>
          {describeError(toggle.error)}
        </InlineAlert>
      ) : null}
    </div>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
