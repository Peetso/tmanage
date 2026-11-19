'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isClientRole } from '@tmanage/domain';
import Link from 'next/link';
import { AppShell } from '../shell/AppShell';
import './work-core.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { listWorkActivity, type WorkActivityEntry } from '../../lib/api/work-activity';
import type { ApiClient } from '../../lib/api/client';
import type { MemberSummary } from '../../lib/api/members';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { connectorSentence } from '../../lib/work-activity-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { getUnfurlCard, unfurlSiteName } from '../../lib/api/unfurl';
import { firstLink, splitLinks } from '../../lib/linkify';
import { LinkPreviewCardView } from '../chat/media/LinkPreviewCard';
import { ActivityFeed, type ActivityFeedRow } from './ActivityFeed';

export interface WorkItemActivityFeedProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

/** A comment body with its http(s) links clickable; everything else stays plain text. */
function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((segment, index) =>
        segment.kind === 'link' ? (
          <a key={index} href={segment.href} target="_blank" rel="noopener noreferrer nofollow">
            {segment.text}
          </a>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}

/**
 * The preview card for a comment's first link, from the org-scoped unfurl proxy. Links the proxy
 * does not preview (not allow-listed, unreachable) draw nothing; the link in the text remains.
 */
function CommentLinkCard({
  api,
  organizationSlug,
  url,
}: {
  api: ApiClient;
  organizationSlug: string;
  url: string;
}) {
  const card = useQuery({
    queryKey: ['unfurl', organizationSlug, url],
    queryFn: () => getUnfurlCard(api, organizationSlug, url),
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (!card.data) return null;
  const href = /^https?:\/\//iu.test(card.data.openUrl) ? card.data.openUrl : card.data.url;
  return (
    <LinkPreviewCardView
      url={href}
      siteName={unfurlSiteName(card.data)}
      title={card.data.title}
      description={card.data.description}
    />
  );
}

type MessageT = ReturnType<typeof useT>;

/**
 * One timeline entry as a feed row. An AI-app move names the person and the app in one sentence;
 * a comment keeps its links clickable and shows the first link's preview card under it. The rows
 * are not links themselves: the item is already open, and a comment carries its own links.
 */
export function workActivityRow(
  entry: WorkActivityEntry,
  t: MessageT,
  directory: { readonly members: readonly MemberSummary[]; readonly isPending: boolean },
  preview: (url: string) => ActivityFeedRow['attachment'],
): ActivityFeedRow {
  const name =
    entry.actorId === null
      ? null
      : memberDisplayName(entry.actorId, directory.members, directory.isPending);
  const member = directory.members.find((candidate) => candidate.userId === entry.actorId);
  const comment = entry.kind === 'comment' ? <LinkifiedText text={entry.summary} /> : null;
  const link = entry.kind === 'comment' ? firstLink(entry.summary) : null;
  const sentence =
    entry.via === 'ai_assistant' && name !== null ? (
      <>
        <span className="tm-wk-story__via">
          {connectorSentence(t, entry.action, name, entry.viaApp)}
        </span>
        {comment ? <> {comment}</> : null}
      </>
    ) : (
      <>
        {name === null ? t('WorkItemActivityFeed.system') : `${name} — `}
        {comment ?? entry.summary}
      </>
    );
  return {
    id: `${entry.kind}:${entry.id}`,
    occurredAt: entry.occurredAt,
    actor:
      name === null ? null : { name, client: member !== undefined && isClientRole(member.role) },
    sentence,
    ...(link === null ? {} : { attachment: preview(link) }),
  };
}

/**
 * **Work item activity timeline (module 7, x291).**
 *
 * `38-MODULE-MAP` §Work — the audit's "Work built; no unified item history". One read-only,
 * chronological feed of what already happened to the item — status changes and other audited
 * moves merged with member comments — newest first, drawn entirely from rows other slices write.
 * Behind `work.read`: anyone who may read the item may read its history, and the API answers 404
 * for an item in another tenant exactly as for one that does not exist. There is no write here;
 * the comment box and the status controls live on their own screens.
 *
 * The timeline itself is the one {@link ActivityFeed} (62-A2, B09); this screen keeps the item's
 * shell and sub-navigation and turns its read into rows.
 */
export function WorkItemActivityFeed({
  organizationSlug,
  organizationName,
  workItemId,
  client,
}: WorkItemActivityFeedProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const tr = useTOr();
  const [now] = useState(() => new Date());

  const activity = useQuery({
    queryKey: ['work-item-activity', organizationSlug, workItemId],
    queryFn: () => listWorkActivity(api, organizationSlug, workItemId),
  });

  // Who did it, by name: the same directory the work item screens resolve owners through.
  const directory = useMembers(api, organizationSlug);

  const preview = (url: string) => (
    <CommentLinkCard api={api} organizationSlug={organizationSlug} url={url} />
  );

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      eyebrow={t('WorkItemActivityFeed.eyebrow')}
      title={t('WorkItemActivityFeed.title')}
      description={t('WorkItemActivityFeed.description')}
    >
      <div className="tm-wk-page tm-stack">
        <nav
          className="tm-segmented tm-wk-subnav"
          aria-label={t('WorkItemActivityFeed.subnavLabel')}
        >
          <Link href={`/${organizationSlug}/work/${workItemId}`}>
            {t('WorkItemActivityFeed.overview')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/activity`} aria-current="page">
            {t('WorkItemActivityFeed.activity')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/links`}>
            {tr('WorkItemLinks.tab', 'Links')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/time-logs`}>
            {t('WorkItemActivityFeed.time')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/estimate`}>
            {t('WorkItemActivityFeed.estimate')}
          </Link>
        </nav>
        <ActivityFeed
          title={t('WorkItemActivityFeed.activity')}
          now={now}
          state={
            activity.isPending
              ? { status: 'loading' }
              : activity.isError
                ? {
                    status: 'error',
                    onRetry: () => void activity.refetch(),
                    detail: describe(activity.error),
                  }
                : {
                    status: 'ready',
                    rows: activity.data.map((entry) =>
                      workActivityRow(entry, t, directory, preview),
                    ),
                  }
          }
          empty={<p className="tm-prose">{t('WorkItemActivityFeed.empty')}</p>}
        />
      </div>
    </AppShell>
  );
}
