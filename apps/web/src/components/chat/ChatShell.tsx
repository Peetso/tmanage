'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useTOr } from '../../lib/i18n/use-t-or';
import { ChatListPane } from './ChatListPane';
import { ChatWorkspaceTabs } from './ChatWorkspaceTabs';
import { chatHref, newGroupHref } from './chat-workspaces';
import './chat-shell.css';

export interface ChatShellProps {
  readonly door: 'studio' | 'portal';
  /** The chat list's own URL; the phone's back arrow returns here. */
  readonly listUrlBase: string;
  readonly activeConversationId?: string;
  /**
   * The left pane. Omitted: a `ChatListPane` for this door, its slug read from `listUrlBase`
   * (`/<slug>/chat` or `/<slug>/portal/chat`); the portal one reads `…/portal/chat/list`.
   */
  readonly list?: ReactNode;
  readonly organizationName?: string;
  readonly api?: ApiClient;
  /** The right pane when no chat is open, under the "Pick a chat" note (New channel). */
  readonly empty?: ReactNode;
  /** The right pane: the open conversation. Omitted on the bare list. */
  readonly children?: ReactNode;
  /**
   * R38 G2: the workspace whose chats are on screen when it is not the app's own (the page's
   * `?ws=`). Studio only; the list, its links and the tabs follow it, the app frame does not.
   */
  readonly workspaceSlug?: string;
}

/**
 * R7 F1/F6 — the two-pane chat layout, inside whatever frame the door draws (the studio's
 * `AppShell`, the portal's `ClientPortalShell`). Desktop: the list (360 px) beside the pane.
 * Phone: one at a time — the list when no chat is open, otherwise the pane with a back arrow.
 * Logical properties only, so `dir="rtl"` mirrors it with no extra rule.
 */
export function ChatShell({
  door,
  listUrlBase,
  activeConversationId,
  list,
  organizationName,
  api,
  empty,
  children,
  workspaceSlug,
}: ChatShellProps) {
  const tOr = useTOr();
  const open = activeConversationId !== undefined;
  const organizationSlug = decodeURIComponent(listUrlBase.split('/').filter(Boolean)[0] ?? '');
  const studio = door === 'studio';
  const chatSlug = studio && workspaceSlug !== undefined ? workspaceSlug : organizationSlug;
  const backHref = studio ? chatHref(organizationSlug, chatSlug) : listUrlBase;
  return (
    <div className="tm-chatshell" data-door={door} data-open={open ? 'true' : 'false'}>
      <aside className="tm-chatshell__list" aria-label={tOr('ChatList.title', 'Chats')}>
        {list ?? (
          <ChatListPane
            api={api ?? browserApiClient()}
            organizationSlug={chatSlug}
            organizationName={organizationName ?? ''}
            listUrlBase={listUrlBase}
            door={door}
            allowNewChat={studio}
            {...(studio
              ? {
                  rowHref: (id: string) => chatHref(organizationSlug, chatSlug, id),
                  newGroupHref: newGroupHref(organizationSlug, chatSlug),
                  header: (
                    <ChatWorkspaceTabs
                      api={api ?? browserApiClient()}
                      shellSlug={organizationSlug}
                      activeSlug={chatSlug}
                    />
                  ),
                }
              : {})}
            {...(activeConversationId === undefined ? {} : { activeConversationId })}
          />
        )}
      </aside>
      <section className="tm-chatshell__pane">
        {open ? (
          <>
            <Link className="tm-chatshell__back" href={backHref}>
              <span aria-hidden="true" className="tm-chatshell__back-arrow">
                ←
              </span>{' '}
              {tOr('ChatList.back', 'Chats')}
            </Link>
            {children}
          </>
        ) : (
          <div className="tm-chatshell__empty">
            <p className="tm-chatshell__empty-title">
              {tOr('ChatList.pickTitle', 'Pick a chat to start messaging')}
            </p>
            <p className="tm-chatshell__empty-body">
              {tOr(
                'ChatList.pickBody',
                'Your channels, groups and direct messages are on the list. New chat starts one.',
              )}
            </p>
            {empty ?? null}
          </div>
        )}
      </section>
    </div>
  );
}
