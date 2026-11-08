'use client';

import Link from 'next/link';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../lib/api/client';
import { chatKeys, fetchChatList } from '../../lib/api/chat';
import { listOrganizations } from '../../lib/api/organizations';
import { useTOr } from '../../lib/i18n/use-t-or';
import { chatHref, chatWorkspaceTabs, workspaceUnread } from './chat-workspaces';

export interface ChatWorkspaceTabsProps {
  readonly api: ApiClient;
  /** The app's current workspace: the tabs never change it. */
  readonly shellSlug: string;
  /** The workspace whose chats are on screen. */
  readonly activeSlug: string;
}

/** How often the other workspaces' unread badges re-read. */
const UNREAD_REFRESH_MS = 60_000;

/**
 * R38 G2 — workspace tabs on the chat page: one per workspace the person belongs to, each with
 * its unread count. A tab opens that workspace's chats at `/<shell>/chat?ws=<slug>`; the rest of
 * the app stays in the shell workspace. Each badge reads that workspace's own chat list with the
 * person's own membership there, so no workspace's data is ever read through another's. Drawn
 * only when the person belongs to more than one workspace.
 */
export function ChatWorkspaceTabs({ api, shellSlug, activeSlug }: ChatWorkspaceTabsProps) {
  const tOr = useTOr();
  const organizations = useQuery({
    queryKey: ['organizations'],
    queryFn: () => listOrganizations(api),
    staleTime: 5 * 60_000,
  });
  const tabs = chatWorkspaceTabs(organizations.data ?? [], shellSlug);
  const unread = useQueries({
    queries: tabs.map((org) => ({
      queryKey: [...chatKeys.list(org.slug, false), 'studio'],
      queryFn: () => fetchChatList(api, org.slug, { door: 'studio' }),
      refetchInterval: UNREAD_REFRESH_MS,
    })),
  });

  if (tabs.length < 2) return null;
  return (
    <nav className="tm-chatws" aria-label={tOr('ChatWorkspaces.label', 'Workspaces')}>
      <ul className="tm-chatws__tabs">
        {tabs.map((org, index) => {
          const rows = unread[index]?.data?.rows;
          const count = rows === undefined ? 0 : workspaceUnread(rows);
          const active = org.slug === activeSlug;
          return (
            <li key={org.slug}>
              <Link
                className="tm-chatws__tab"
                href={chatHref(shellSlug, org.slug)}
                aria-current={active ? 'page' : undefined}
                data-active={active ? 'true' : 'false'}
              >
                <span className="tm-chatws__name">{org.name}</span>
                {count > 0 ? (
                  <span
                    className="tm-chatws__badge"
                    aria-label={tOr('ChatWorkspaces.unread', '{count} unread').replace(
                      '{count}',
                      String(count),
                    )}
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
