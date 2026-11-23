'use client';

import Link from 'next/link';
import { useContext } from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { StateCapsule } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { listPendingAiApprovals, pendingAiApprovalsKey } from '../../lib/api/ai-approvals';
import type { AiApprovalView } from '../../lib/api/ai-approvals';
import { useTOr } from '../../lib/i18n/use-t-or';
import { yourAiHref } from '../ai-panel/open-your-ai';

/**
 * 55-15p — the actions an AI assistant asked for that wait for the member's approval.
 *
 * One shared query (`pendingAiApprovalsKey`) feeds the "AI actions" menu badge, the AI assistant
 * page's waiting card and the AI actions list, so they always agree and the page asks once. A
 * refusal (AI switched off, a role without `ai.use`) reads as "nothing waiting": the badge simply
 * does not show. Without a query client (a story) nothing is fetched.
 */

/** Stands in when no `QueryClientProvider` is mounted, so the hook never throws; never fetches. */
const IDLE_QUERY_CLIENT = new QueryClient();

export function usePendingAiApprovals(organizationSlug: string, client?: ApiClient) {
  const queryClient = useContext(QueryClientContext);
  return useQuery(
    {
      queryKey: pendingAiApprovalsKey(organizationSlug),
      queryFn: () => listPendingAiApprovals(client ?? browserApiClient(), organizationSlug),
      staleTime: 30_000,
      retry: false,
      enabled: queryClient !== undefined,
    },
    queryClient ?? IDLE_QUERY_CLIENT,
  );
}

/** Where "Review" goes: straight to the one waiting action, else the AI actions list. */
export function reviewHref(organizationSlug: string, items: readonly AiApprovalView[]): string {
  const only = items.length === 1 ? items[0] : undefined;
  return only
    ? `/${organizationSlug}/ai/approve/${encodeURIComponent(only.id)}`
    : `/${organizationSlug}/settings/ai-actions`;
}

/**
 * "2 waiting" — the amber Waiting capsule (review point 8), the same as "Review requested". It is
 * its own link: it opens the AI panel straight on tab 2, "Your AI" (`yourAiHref`), so it sits
 * beside the menu entry's link, never inside it.
 */
export function PendingAiActionsBadge({ organizationSlug }: { organizationSlug: string }) {
  const tOr = useTOr();
  const pending = usePendingAiApprovals(organizationSlug);
  const count = pending.data?.length ?? 0;
  if (count === 0) return null;
  const shown = String(count);
  return (
    <Link
      href={yourAiHref(organizationSlug)}
      prefetch={false}
      className="tm-cc-sections__waiting-link"
      aria-label={tOr('AiAssistantScreen.navWaitingOpen', '{count} waiting, open Your AI').replace(
        '{count}',
        shown,
      )}
    >
      <StateCapsule state="waiting" className="tm-cc-sections__waiting">
        {tOr('AiAssistantScreen.navWaiting', '{count} waiting').replace('{count}', shown)}
      </StateCapsule>
    </Link>
  );
}

/**
 * "2 actions from Claude are waiting for your approval". Arabic counts: one, two, 3–10, 11+.
 * `client` is the assistant's name when every waiting action came from the same one.
 */
export function pendingTitle(
  tOr: (key: string, english: string) => string,
  count: number,
  client: string | null,
): string {
  const who = client ?? tOr('AiAssistantScreen.pendingYourAssistant', 'your assistant');
  const form =
    count === 1 ? 'One' : count === 2 ? 'Two' : count >= 3 && count <= 10 ? 'Few' : 'Many';
  const english =
    count === 1
      ? '1 action from {client} is waiting for your approval'
      : '{count} actions from {client} are waiting for your approval';
  return tOr(`AiAssistantScreen.pendingTitle${form}`, english)
    .replace('{count}', String(count))
    .replace('{client}', who);
}

/** The assistant's name when all the waiting actions came from one, else null. */
export function singleClient(items: readonly AiApprovalView[]): string | null {
  const names = new Set(items.map((item) => item.clientName));
  return names.size === 1 ? (items[0]?.clientName ?? null) : null;
}
