'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPins, unpinMessage } from '../../lib/api/message-pins';
import type { PinnedMessage } from '../../lib/api/message-pins';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PinnedMessagesViewProps {
  organizationSlug: string;
  conversationId: string;
  /**
   * Whether the viewer may curate the strip. Pinning and unpinning are behind
   * `conversation.moderate`; a reader without it sees the strip but no unpin control, matching what
   * the API would refuse.
   */
  canModerate?: boolean;
  client?: ApiClient | undefined;
}

/**
 * **x247 — the pinned strip at the top of a conversation (CH-02 "pinned context", CH-07 pin).**
 *
 * A faithful reader of the API's pinned messages: it reads `GET .../conversations/:id/pins` (behind
 * `conversation.read`) and lists each pin oldest first, the order the API returns. A pin is a
 * *reference* — its message id and who pinned it — not a copy of the message, so each row names the
 * message it points at; resolving a pin to the live message body is the channel view's to do beside
 * this strip. A moderator gets an unpin control per row (`DELETE .../pin`, `conversation.moderate`);
 * on success the strip refetches. The region is its own labelled landmark so it is axe-clean.
 */
export function PinnedMessagesView({
  organizationSlug,
  conversationId,
  canModerate = false,
  client,
}: PinnedMessagesViewProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['conversation', conversationId, 'pins'] as const;

  const pins = useQuery({
    queryKey,
    queryFn: () => listPins(api, organizationSlug, conversationId),
  });

  const unpin = useMutation({
    mutationFn: (messageId: string) =>
      unpinMessage(api, organizationSlug, conversationId, messageId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const items = pins.data ?? [];

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-conversation-pins">
      <h2 id="tm-conversation-pins" className="tm-eyebrow">
        Pinned messages
      </h2>

      {pins.isLoading ? (
        <LoadingRegion label="Loading pinned messages.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : pins.isError ? (
        <InlineAlert tone="danger" title="Could not load pinned messages" live>
          {pins.error instanceof NetworkError
            ? 'The network dropped. Try again.'
            : pins.error instanceof ApiRequestError
              ? pins.error.message
              : 'Something went wrong.'}
        </InlineAlert>
      ) : items.length === 0 ? (
        <InlineAlert tone="neutral" title="No pinned messages">
          Nothing is pinned to this conversation yet.
        </InlineAlert>
      ) : (
        <ul className="tm-stack" aria-label="Pinned messages">
          {items.map((pin: PinnedMessage) => (
            <li key={pin.id} className="tm-row">
              <span className="tm-row__main">Message {pin.messageId}</span>
              {canModerate ? (
                <Button
                  tone="text"
                  size="compact"
                  onClick={() => unpin.mutate(pin.messageId)}
                  loading={unpin.isPending}
                  loadingLabel="Unpinning the message."
                >
                  Unpin
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {unpin.isError ? (
        <InlineAlert tone="danger" title="Could not unpin the message" live>
          {unpin.error instanceof ApiRequestError
            ? unpin.error.message
            : 'Something went wrong. Try again.'}
        </InlineAlert>
      ) : null}
    </section>
  );
}
