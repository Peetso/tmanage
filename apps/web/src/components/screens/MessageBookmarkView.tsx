'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { InlineAlert, TextButton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { removeMessageBookmark, saveMessageBookmark } from '../../lib/api/message-bookmarks';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MessageBookmarkViewProps {
  organizationSlug: string;
  conversationId: string;
  messageId: string;
  /** Whether the caller has already saved this message — draws the toggle's starting state. */
  initialSaved?: boolean;
  /** Notified after a successful toggle so a list view can refetch. */
  onChange?: (saved: boolean) => void;
  client?: ApiClient;
}

/**
 * x248 — the per-message "Save" toggle (CH-07 "Message actions"). Paired with
 * {@link import('./SavedMessagesScreen').SavedMessagesScreen}, which lists what this saves.
 *
 * The toggle is optimistic-free but idempotent: the API answers 200 for a save whether or not one
 * existed and 204 for an unsave whether or not there was anything to remove, so the button simply
 * flips `saved` on success and never has to reconcile a race. A refusal (a message in a
 * conversation the caller no longer reads is a 404) surfaces inline and leaves the state untouched.
 */
export function MessageBookmarkView({
  organizationSlug,
  conversationId,
  messageId,
  initialSaved = false,
  onChange,
  client,
}: MessageBookmarkViewProps) {
  const api = client ?? browserApiClient();
  const [saved, setSaved] = useState(initialSaved);

  const toggle = useMutation({
    mutationFn: async (): Promise<boolean> => {
      if (saved) {
        await removeMessageBookmark(api, organizationSlug, conversationId, messageId);
        return false;
      }
      await saveMessageBookmark(api, organizationSlug, conversationId, messageId);
      return true;
    },
    onSuccess: (next) => {
      setSaved(next);
      onChange?.(next);
    },
  });

  const error = toggle.error;

  return (
    <span className="tm-message-bookmark">
      <TextButton
        type="button"
        aria-pressed={saved}
        disabled={toggle.isPending}
        onClick={() => toggle.mutate()}
      >
        {saved ? 'Saved' : 'Save'}
      </TextButton>
      {error ? (
        <InlineAlert tone="danger" live>
          {error instanceof ApiRequestError
            ? 'This message could not be saved.'
            : error instanceof NetworkError
              ? 'Could not reach the server. Try again.'
              : 'Something went wrong.'}
        </InlineAlert>
      ) : null}
    </span>
  );
}
