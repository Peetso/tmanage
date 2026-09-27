'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, InlineAlert, Skeleton, Switch } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import { getConversationMute, setConversationMute } from '../../lib/api/conversation-mute';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface ConversationMuteViewProps {
  organizationSlug: string;
  conversationId: string;
  client?: ApiClient;
}

/**
 * **Conversation mute (module Chat, CH-09 "Channel details", x252).**
 *
 * The toggle in a channel's settings that silences its notifications for the acting member only, and
 * the muted indicator the channel list reads from the same state. A member reads their own state
 * (`false` when never set), flips it, and the change is persisted behind `conversation.read`, scoped
 * to the caller's own membership by the server — muting is a personal preference, not a change to the
 * channel, so it never needs the write capability. The mute state is dispatch-neutral for now; this
 * is the durable preference a later notification change honours.
 */
export function ConversationMuteView({
  organizationSlug,
  conversationId,
  client = browserApiClient(),
}: ConversationMuteViewProps) {
  const queryClient = useQueryClient();
  const queryKey = ['conversation-mute', organizationSlug, conversationId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => getConversationMute(client, organizationSlug, conversationId),
  });

  const mutation = useMutation({
    mutationFn: (muted: boolean) =>
      setConversationMute(client, organizationSlug, conversationId, muted),
    onSuccess: (view) => {
      queryClient.setQueryData(queryKey, view);
    },
  });

  if (query.isPending) {
    return <Skeleton aria-label="Loading mute state" />;
  }

  if (query.isError) {
    const error = query.error;
    const message =
      error instanceof ApiRequestError || error instanceof NetworkError
        ? error.message
        : 'The mute state could not be loaded.';
    return <InlineAlert tone="danger">{message}</InlineAlert>;
  }

  const muted = query.data.muted;

  return (
    <div className="tm-conversation-mute">
      {muted ? <Badge tone="neutral">Muted</Badge> : null}
      <Switch
        label="Mute notifications for this channel"
        hint="Only you are muted. This does not change the channel for anyone else."
        checked={muted}
        disabled={mutation.isPending}
        onChange={(event) => mutation.mutate(event.currentTarget.checked)}
      />
      {mutation.isError ? (
        <InlineAlert tone="danger">Your change could not be saved. Try again.</InlineAlert>
      ) : null}
    </div>
  );
}
