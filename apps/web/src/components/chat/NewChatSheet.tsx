'use client';

import Link from 'next/link';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { NewMessageDialog } from './NewMessageDialog';

export interface NewChatSheetProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly organizationName: string;
  readonly onClose: () => void;
  /** Called with the direct conversation's id (a `conversations` row since R7). */
  readonly onOpened: (conversationId: string) => void;
  /** R38 G2: "New group" for the workspace on screen. Default `/<slug>/chat?new=group`. */
  readonly newGroupHref?: string;
}

/**
 * R7 "New chat": pick a person to open (create-or-get) a direct conversation, or go to "New group"
 * (slice 3's `?new=group` route on the chat list).
 */
export function NewChatSheet({
  api,
  organizationSlug,
  organizationName,
  onClose,
  onOpened,
  newGroupHref,
}: NewChatSheetProps) {
  const tOr = useTOr();
  return (
    <NewMessageDialog
      api={api}
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      onClose={onClose}
      onOpened={(conversation) => onOpened(conversation.id)}
      extraAction={
        <Link
          className="tm-chatlist__newgroup"
          href={newGroupHref ?? `/${organizationSlug}/chat?new=group`}
        >
          <span aria-hidden="true">👥</span> {tOr('ChatList.newGroup', 'New group')}
        </Link>
      }
    />
  );
}
