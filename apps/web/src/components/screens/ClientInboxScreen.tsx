'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { useSelectedPortalProject } from '../shell/PortalProjectSwitcher';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  DEFAULT_PORTAL_INBOX_PAGE,
  listPortalInbox,
  listPortalProjects,
  markPortalBundleRead,
} from '../../lib/api/portal';
import type {
  PortalInboxBundle,
  PortalInboxFileBundle,
  PortalInboxMode,
} from '../../lib/api/portal';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { requestStatusLabel } from '../../lib/client-request-presentation';
import { formatInstant } from '../../lib/work-item-presentation';
import { Segmented, Tag } from './PortalParts';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { compactUnit, translateOr } from '../../lib/i18n/compact-time';
import { portalFileViewerHref } from './PortalReviewLink';
import '../../styles/screens/inbox.css';

export interface ClientInboxScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * The client's inbox — INBOX-001's second half, on the portal.
 *
 * ## This screen has no ID, and that is a divergence rather than an invention
 *
 * `22-SCREEN-BY-SCREEN` §6 gives the client `CL-08 Updates` — "published status updates and
 * decisions", a feed the studio writes — and no inbox. `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX`
 * §4's `IN-01` through `IN-07` are the internal inbox. But NOTIF-001 writes a row to the
 * client who submitted a request every time the studio answers it, and until this screen
 * those rows had no reader. So the page exists, at `/portal/inbox`, reached from `CL-01`;
 * **`CLIENT_NAVIGATION` was not touched**, for the reason `ClientRequestsScreen` gives — a
 * rail item §1 does not list would be a destination this codebase invented. The divergence is
 * recorded in `docs/implementation-status.md`.
 *
 * ## What a row says
 *
 * One row per request, with the title and the client-safe status the API read through the
 * portal's own path at the moment of the request — the same words `CL-06` uses, and never an
 * internal state. Each row links to the request. The API dropped, before answering, any row
 * about a request this client may no longer see; the screen has no way to ask for them.
 *
 * ## Two modes, one action
 *
 * `All` and `Unread` are the API's two queries, not a filter over the page. "Mark read" posts
 * the bundle id and asks the list again, as `TM-04` does: the API reauthorizes before it
 * writes, and the screen has no way to know what it decided except by reading.
 */
export function ClientInboxScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: ClientInboxScreenProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const t = useT();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<PortalInboxMode>('all');
  const now = useNow();

  const projects = useQuery({
    queryKey: ['portal-projects', organizationSlug],
    queryFn: () => listPortalProjects(api, organizationSlug),
  });

  const inbox = useInfiniteQuery({
    queryKey: ['portal-inbox', organizationSlug, mode],
    queryFn: ({ pageParam }) =>
      listPortalInbox(api, organizationSlug, {
        mode,
        limit: DEFAULT_PORTAL_INBOX_PAGE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const markRead = useMutation({
    mutationFn: (bundleId: string) => markPortalBundleRead(api, organizationSlug, bundleId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['portal-inbox', organizationSlug] }),
  });

  const bundles = mergePages(inbox.data?.pages.map((page) => page.items) ?? []);
  const project = useSelectedPortalProject(projects.data);

  const selectMode = (next: PortalInboxMode) => {
    markRead.reset();
    setMode(next);
  };

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="overview"
      title={t('ClientInboxScreen.title')}
      eyebrow={
        project
          ? `${t('ClientInboxScreen.notificationsPrefix')}${project.name}`
          : t('ClientInboxScreen.notifications')
      }
      description={`${t('ClientInboxScreen.descPrefix')}${providerName}${t('ClientInboxScreen.descSuffix')}`}
      headerAside={
        <Segmented<PortalInboxMode>
          label={t('ClientInboxScreen.notificationMode')}
          value={mode}
          onChange={selectMode}
          options={[
            { id: 'all', label: t('ClientInboxScreen.modeAll') },
            { id: 'unread', label: t('ClientInboxScreen.modeUnread') },
          ]}
        />
      }
    >
      <div className="tm-pt tm-pt--compact">
        {inbox.isError ? (
          <InlineAlert tone="danger" title={t('ClientInboxScreen.loadError')} live>
            {describe(inbox.error)}
          </InlineAlert>
        ) : null}

        {markRead.isError ? (
          <InlineAlert tone="danger" title={t('ClientInboxScreen.markReadError')} live>
            {describe(markRead.error)}
          </InlineAlert>
        ) : null}

        {inbox.isPending ? (
          <LoadingRegion label={t('ClientInboxScreen.loadingLabel')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {/* "Nothing" only once the API has said it: a page can be short while a cursor remains. */}
        {!inbox.isPending && !inbox.isError && bundles.length === 0 && !inbox.hasNextPage ? (
          <div className="tm-pt-card tm-pt-card--dashed tm-pt-card--lg">
            <h2 className="tm-pt-card__title">
              {mode === 'all'
                ? t('ClientInboxScreen.emptyAllTitle')
                : t('ClientInboxScreen.emptyUnreadTitle')}
            </h2>
            <p className="tm-pt-card__body">
              {mode === 'all' ? (
                <>
                  {t('ClientInboxScreen.emptyAllBodyBefore')}
                  {providerName}
                  {t('ClientInboxScreen.emptyAllBodyAfter')}
                </>
              ) : (
                t('ClientInboxScreen.emptyUnreadBody')
              )}
            </p>
          </div>
        ) : null}

        {!inbox.isPending && !inbox.isError && bundles.length === 0 && inbox.hasNextPage ? (
          <p className="tm-pt-card tm-pt-card--dashed tm-pt-card__body">
            {t('ClientInboxScreen.olderPages')}
          </p>
        ) : null}

        {bundles.length > 0 ? (
          <ul className="tm-pt-list" aria-label={t('ClientInboxScreen.yourNotifications')}>
            {bundles.map((bundle) =>
              'fileAssetId' in bundle ? (
                <li key={bundle.bundleId}>
                  <FileReviewCard
                    organizationSlug={organizationSlug}
                    bundle={bundle}
                    now={now}
                    marking={markRead.isPending && markRead.variables === bundle.bundleId}
                    onMarkRead={() => markRead.mutate(bundle.bundleId)}
                  />
                </li>
              ) : (
                <li
                  key={bundle.bundleId}
                  className={
                    bundle.unreadCount > 0 ? 'tm-pt-action tm-pt-action--lead' : 'tm-pt-action'
                  }
                >
                  <span className="tm-pt-action__orb" aria-hidden="true">
                    {bundle.unreadCount > 0 ? bundle.unreadCount : '✓'}
                  </span>
                  <div className="tm-pt-action__body">
                    <div className="tm-pt-action__meta">
                      <Tag tone={bundle.status === 'clarifying' ? 'lime' : undefined}>
                        {requestStatusLabel(bundle.status)}
                      </Tag>
                      <span className="tm-pt-mono">{describeCounts(bundle, mode)}</span>
                    </div>
                    <h2 className="tm-pt-action__title">
                      <Link href={`/${organizationSlug}/portal/requests/${bundle.requestId}`}>
                        {bundle.title}
                      </Link>
                    </h2>
                    <p className="tm-pt-action__text">
                      {describeWhy(bundle, providerName)} · Latest {formatInstant(bundle.latestAt)}
                    </p>
                  </div>
                  {bundle.unreadCount > 0 ? (
                    <div className="tm-pt-action__end">
                      <Button
                        tone="outline"
                        size="accessible"
                        loading={markRead.isPending && markRead.variables === bundle.bundleId}
                        loadingLabel={t('ClientInboxScreen.markingRead')}
                        aria-label={`${t('ClientInboxScreen.markReadPrefix')}${bundle.title}`}
                        onClick={() => markRead.mutate(bundle.bundleId)}
                      >
                        {t('ClientInboxScreen.markRead')}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        ) : null}

        {inbox.hasNextPage ? (
          <div className="tm-pt-form__actions">
            <Button
              tone="outline"
              size="accessible"
              loading={inbox.isFetchingNextPage}
              loadingLabel={t('ClientInboxScreen.loadingMore')}
              onClick={() => void inbox.fetchNextPage()}
            >
              {t('ClientInboxScreen.loadMore')}
            </Button>
          </div>
        ) : null}

        {/*
        WCAG 2.2 4.1.3: announce the running total when "Load more" adds notifications, so a
        screen-reader user is told the press landed instead of listening to silence.
      */}
        <Announce
          message={
            (inbox.data?.pages.length ?? 0) > 1 && !inbox.isFetchingNextPage
              ? `${bundles.length} ${bundles.length === 1 ? 'notification' : 'notifications'} loaded in total.`
              : ''
          }
        />
      </div>
    </ClientPortalShell>
  );
}

/** The review notices a client is told about, in the internal inbox's words (V-50). */
const REVIEW_WHY_KEYS: Record<string, MessageKey> = {
  'review.comment_added.v1': 'InboxScreen.whyReviewComment',
  'review.replied.v1': 'InboxScreen.whyReviewReplied',
  'review.mentioned.v1': 'InboxScreen.whyReviewMentioned',
  'review.thread_resolved.v1': 'InboxScreen.whyReviewResolved',
  'review.thread_reopened.v1': 'InboxScreen.whyReviewReopened',
};

interface FileReviewCardProps {
  organizationSlug: string;
  bundle: PortalInboxFileBundle;
  now: Date | null;
  marking: boolean;
  onMarkRead: () => void;
}

/**
 * R4 Batch F follow-up — a file under review as the V-50 card draws it: "File · <what happened>",
 * the file's name, the counts, the steps into an "In review" capsule, and Open (the portal viewer)
 * beside Mark read. The internal card's Snooze and Details are not drawn for the portal: a client
 * inbox has neither.
 */
function FileReviewCard({
  organizationSlug,
  bundle,
  now,
  marking,
  onMarkRead,
}: FileReviewCardProps) {
  const t = useT();
  const steps = bundle.types.flatMap((type) => {
    const key = REVIEW_WHY_KEYS[type];
    return key ? [{ type, text: t(key) }] : [];
  });
  const href = portalFileViewerHref(organizationSlug, bundle.fileAssetId);
  const titleId = `tm-client-inbox-${bundle.bundleId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  return (
    <article className="tm-inbox-card" aria-labelledby={titleId}>
      <div className="tm-inbox-card__head">
        <span className="tm-inbox-orb" aria-hidden="true">
          ◫
        </span>
        <span className="tm-inbox-card__who">
          {[t('InboxScreen.kindFile'), steps.map((step) => step.text).join(', ')]
            .filter((part) => part !== '')
            .join(' · ')}
        </span>
        <time
          className="tm-inbox-card__when"
          dateTime={bundle.latestAt}
          title={formatInstant(bundle.latestAt)}
        >
          {now ? shortAgo(bundle.latestAt, now) : ''}
        </time>
      </div>
      <h2 className="tm-inbox-card__title" id={titleId}>
        <Link href={href}>{bundle.title}</Link>
      </h2>
      <p className="tm-inbox-card__body">
        <span>
          {bundle.count}{' '}
          {bundle.count === 1 ? t('InboxScreen.updateWord') : t('InboxScreen.updatesWord')}
        </span>
        {bundle.unreadCount > 0 ? (
          <span className="tm-inbox-card__unread">
            {bundle.unreadCount} {t('InboxScreen.unread')}
          </span>
        ) : null}
      </p>
      <div className="tm-inbox-track">
        {steps.map((step) => (
          <span key={step.type} className="tm-inbox-track__step">
            {step.text}
          </span>
        ))}
        <span className="tm-inbox-track__arrow" aria-hidden="true">
          →
        </span>
        <StateCapsule state="neutral">{t('InboxScreen.stateFile')}</StateCapsule>
      </div>
      <div className="tm-inbox-card__actions">
        <Link
          href={href}
          className="tm-button tm-button--ink tm-button--compact"
          aria-label={`${t('InboxScreen.openAriaPrefix')} ${bundle.title}`}
        >
          {t('InboxScreen.openLink')}
        </Link>
        {bundle.unreadCount > 0 ? (
          <Button
            tone="outline"
            size="compact"
            loading={marking}
            loadingLabel={t('ClientInboxScreen.markingRead')}
            aria-label={`${t('InboxScreen.markReadAriaPrefix')} ${bundle.title}`}
            onClick={onMarkRead}
          >
            {t('InboxScreen.markRead')}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** The browser's clock, read after mount so the server render and the first client render agree. */
function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** "12m", "26h", "2d" — the V-50 card's mono age, as the internal inbox says it. */
function shortAgo(value: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(value).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return value;
  if (minutes < 1) return translateOr('CompactTime.now', 'now');
  if (minutes < 60) return compactUnit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? compactUnit(hours, 'hour') : compactUnit(Math.floor(hours / 24), 'day');
}

/**
 * The event types the portal is told about, said in words. The API allowlists `types`, so an
 * unknown identifier never arrives; if the list is empty the row still says something, and
 * what it says is a sentence rather than a wire identifier.
 */
const WHY: Record<string, (provider: string) => string> = {
  'client_request.transitioned.v1': (provider) => `${provider} answered`,
};

function describeWhy(bundle: PortalInboxBundle, providerName: string): string {
  const words = bundle.types.flatMap((type) => {
    const say = WHY[type];
    return say ? [say(providerName)] : [];
  });
  return words.length > 0 ? words.join(', ') : `${providerName} updated this`;
}

/**
 * `count` is the number of rows the API's query returned about the request, and the query is
 * the mode: in `unread` every row is unread, so "2 unread of 2" would be a ratio over a total
 * the page never held. Each mode says only what its query can vouch for.
 */
function describeCounts(bundle: PortalInboxBundle, mode: PortalInboxMode): string {
  if (mode === 'unread') return `${bundle.unreadCount} unread`;
  const updates = `${bundle.count} ${bundle.count === 1 ? 'update' : 'updates'}`;
  return bundle.unreadCount > 0 ? `${updates}, ${bundle.unreadCount} unread` : updates;
}

/**
 * The API bundles one page at a time, so a request whose rows straddle a page boundary
 * arrives twice. Folded here as `TM-04` folds: counts add, unread counts add, types union,
 * the newest time wins, and the row keeps the place of its first appearance.
 */
function mergePages(
  pages: readonly (readonly PortalInboxBundle[])[],
): readonly PortalInboxBundle[] {
  const byId = new Map<string, PortalInboxBundle>();
  for (const page of pages) {
    for (const bundle of page) {
      const seen = byId.get(bundle.bundleId);
      if (!seen) {
        byId.set(bundle.bundleId, bundle);
        continue;
      }
      const types = [...seen.types];
      for (const type of bundle.types) if (!types.includes(type)) types.push(type);
      byId.set(bundle.bundleId, {
        ...seen,
        count: seen.count + bundle.count,
        unreadCount: seen.unreadCount + bundle.unreadCount,
        types,
        latestAt: seen.latestAt >= bundle.latestAt ? seen.latestAt : bundle.latestAt,
      });
    }
  }
  return [...byId.values()];
}
