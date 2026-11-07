'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import Link from 'next/link';
import { AppShell } from '../shell/AppShell';
import './work-core.css';
import { browserApiClient } from '../../lib/api/browser-client';
import { listWorkActivity, type WorkActivityEntry } from '../../lib/api/work-activity';
import type { ApiClient } from '../../lib/api/client';
import { memberDisplayName } from '../../lib/members-presentation';
import { useMembers } from '../../lib/use-members';
import { connectorSentence } from '../../lib/work-activity-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { appLocale } from '../../lib/i18n/app-locale';
import { getUnfurlCard, unfurlSiteName } from '../../lib/api/unfurl';
import { firstLink, splitLinks } from '../../lib/linkify';
import { LinkPreviewCardView } from '../chat/media/LinkPreviewCard';

export interface WorkItemActivityFeedProps {
  organizationSlug: string;
  organizationName: string;
  workItemId: string;
  client?: ApiClient;
}

function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(appLocale());
}

/** A small glyph per entry kind — a spoken label goes on the row, this is decoration only. */
function icon(kind: WorkActivityEntry['kind']): string {
  return kind === 'comment' ? '◌' : '●';
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

function CommentBody({
  api,
  organizationSlug,
  text,
}: {
  api: ApiClient;
  organizationSlug: string;
  text: string;
}) {
  const link = firstLink(text);
  return (
    <>
      <LinkifiedText text={text} />
      {link === null ? null : (
        <CommentLinkCard api={api} organizationSlug={organizationSlug} url={link} />
      )}
    </>
  );
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

  const activity = useQuery({
    queryKey: ['work-item-activity', organizationSlug, workItemId],
    queryFn: () => listWorkActivity(api, organizationSlug, workItemId),
  });

  // Who did it, by name: the same directory the work item screens resolve owners through.
  const directory = useMembers(api, organizationSlug);

  const entries: readonly WorkActivityEntry[] = activity.data ?? [];

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
          <Link href={`/${organizationSlug}/work/${workItemId}/time-logs`}>
            {t('WorkItemActivityFeed.time')}
          </Link>
          <Link href={`/${organizationSlug}/work/${workItemId}/estimate`}>
            {t('WorkItemActivityFeed.estimate')}
          </Link>
        </nav>
        <section className="tm-panel tm-stack" aria-labelledby="tm-work-activity">
          <h2 id="tm-work-activity" className="tm-eyebrow">
            {t('WorkItemActivityFeed.activity')}
          </h2>

          {activity.isPending ? (
            <LoadingRegion label={t('WorkItemActivityFeed.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {activity.isError ? (
            <InlineAlert tone="danger" title={t('WorkItemActivityFeed.loadError')} live>
              {describe(activity.error)}
            </InlineAlert>
          ) : null}

          {activity.data ? (
            entries.length === 0 ? (
              <p className="tm-prose">{t('WorkItemActivityFeed.empty')}</p>
            ) : (
              <ol className="tm-wk-story" aria-label={t('WorkItemActivityFeed.timelineLabel')}>
                {entries.map((entry, index) => (
                  <li
                    key={`${entry.kind}:${entry.id}`}
                    {...(index === 0 ? { 'data-state': 'now' } : {})}
                  >
                    <time className="tm-wk-story__when" dateTime={entry.occurredAt}>
                      <span aria-hidden="true">{icon(entry.kind)}</span>{' '}
                      {formatWhen(entry.occurredAt)}
                    </time>
                    <span className="tm-wk-story__what">
                      {entry.via === 'ai_assistant' && entry.actorId ? (
                        <>
                          <span className="tm-wk-story__via">
                            {connectorSentence(
                              t,
                              entry.action,
                              memberDisplayName(
                                entry.actorId,
                                directory.members,
                                directory.isPending,
                              ),
                              entry.viaApp,
                            )}
                          </span>
                          {entry.kind === 'comment' ? (
                            <>
                              {' '}
                              <CommentBody
                                api={api}
                                organizationSlug={organizationSlug}
                                text={entry.summary}
                              />
                            </>
                          ) : null}
                        </>
                      ) : (
                        <>
                          {entry.actorId
                            ? `${memberDisplayName(entry.actorId, directory.members, directory.isPending)} — `
                            : t('WorkItemActivityFeed.system')}
                          {entry.kind === 'comment' ? (
                            <CommentBody
                              api={api}
                              organizationSlug={organizationSlug}
                              text={entry.summary}
                            />
                          ) : (
                            entry.summary
                          )}
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            )
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
