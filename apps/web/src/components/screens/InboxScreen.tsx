'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CLIENT_REQUEST_STATES, WORK_ITEM_STATES } from '@tmanage/domain';
import type { ClientRequestState, WorkItemState } from '@tmanage/domain';
import { Announce, Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { DEFAULT_INBOX_PAGE, listInbox, markBundleRead } from '../../lib/api/inbox';
import type { InboxBundle, InboxItem, InboxMode, InboxUsageNotice } from '../../lib/api/inbox';
import type { ApiClient } from '../../lib/api/client';
import { compactUnit, translateOr } from '../../lib/i18n/compact-time';
import { activeLocale } from '../../lib/i18n/locale-store';
import { withNumerals } from '../../lib/i18n/display-format';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { markBundleDone, snoozeBundle, unsnoozeBundle } from '../../lib/api/inbox-snooze';
import type { MessageKey } from '../../lib/i18n/t';
import { formatInstant, stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import { triageStateCapsule, triageStateLabel } from '../../lib/triage-presentation';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import '../../styles/screens/inbox.css';

export interface InboxScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **TM-04 Inbox** — `22-SCREEN-BY-SCREEN` §TM-04, `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §4
 * (`IN-01` through `IN-04`), and the Inbox part of `WEB-010 Home/Inbox/Search/Admin screens`,
 * over the first half of `INBOX-001`. Painted as the handoff's IN-01 / IN-05 frame: a 504px
 * column of bundle cards beside the detail of the selected bundle.
 *
 * ## The four modes are the API's, not the screen's
 *
 * `REQ-01` filters a list it already holds, so its buttons carry counts. This screen cannot: a
 * mode is a different query — `waiting_on_me` is a different `WHERE`, and `important` is
 * decided by what each bundle contains after the API has resolved it — so switching a mode
 * refetches, and the capsules say what they are without a number the page does not know. A
 * count for a mode not on screen would be a count the API never gave.
 *
 * ## What a card says, and what it does not
 *
 * A bundle is one object and every notification about it. The card shows the object's title
 * and current state — both read by the API through the object's own authorized path at the
 * moment of the request, which is why a bundle about something this person may no longer see
 * never arrives here — the number of updates, how many are unread, and the latest time. The
 * "why" is the event type, said in words: `Blocked`, `Client submitted a request`. Nothing
 * ranks, scores or reorders: the frame's `Due today` and `Blocks 2 people` need facts no
 * notification row carries and no endpoint yet computes, so the detail column only restates
 * what the bundle itself holds.
 *
 * ## One inline action, reauthorized where it runs
 *
 * "Mark read" is the one action TM-04 has today. It posts to the API, which re-reads the
 * object before it writes anything, exactly as the list does; the screen offers the button
 * and then asks the list again rather than pretending it knows the outcome.
 */
export function InboxScreen({ organizationSlug, organizationName, client }: InboxScreenProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const tOr = useTOr();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<InboxMode>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<string | null>(null);
  const [snoozedNotice, setSnoozedNotice] = useState<{ bundleId: string; text: string } | null>(
    null,
  );
  const now = useNow();
  const canUse = useShellCapability(organizationSlug, client);

  // 2026-10-31 live test: the chosen filter was lost on reload. The mode lives in `?mode=`,
  // read once on mount and written with replaceState so Back is not filled with filter clicks.
  useEffect(() => {
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('mode');
      if (fromUrl !== null && isInboxMode(fromUrl)) setMode(fromUrl);
    } catch {
      // No URL to read: the default mode stands.
    }
  }, []);

  const inbox = useInfiniteQuery({
    queryKey: ['inbox', organizationSlug, mode],
    queryFn: ({ pageParam }) =>
      listInbox(api, organizationSlug, {
        mode,
        limit: DEFAULT_INBOX_PAGE,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const markRead = useMutation({
    mutationFn: (bundleId: string) => markBundleRead(api, organizationSlug, bundleId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inbox', organizationSlug] }),
  });

  const bundles = mergePages(inbox.data?.pages.map((page) => page.items) ?? []);
  const selected = bundles.find((item) => item.bundleId === selectedId) ?? bundles[0];
  const unreadBundles = bundles.filter((item) => item.unreadCount > 0).length;

  // A mode is a different list. A "could not mark that read" about a row of the old list
  // would otherwise stay on screen above rows it does not name.
  const selectMode = (next: InboxMode) => {
    markRead.reset();
    setSelectedId(null);
    setSnoozeMenuFor(null);
    setMode(next);
    try {
      const url = new URL(window.location.href);
      if (next === 'all') url.searchParams.delete('mode');
      else url.searchParams.set('mode', next);
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {
      // Keeping the filter in the URL is a convenience; the list works without it.
    }
  };

  // Snooze takes a card out of the list until the chosen time (the API leaves snoozed bundles
  // out). The confirmation offers Undo, which un-snoozes and brings the card straight back.
  const snooze = useMutation({
    mutationFn: ({ bundleId, hours }: { bundleId: string; hours: number }) =>
      snoozeBundle(
        api,
        organizationSlug,
        bundleId,
        new Date(Date.now() + hours * 3600 * 1000).toISOString(),
      ),
    onSuccess: (_result, { bundleId, hours }) => {
      setSnoozeMenuFor(null);
      setSnoozedNotice({ bundleId, text: snoozedText(hours, tOr) });
      if (selectedId === bundleId) setSelectedId(null);
      return queryClient.invalidateQueries({ queryKey: ['inbox', organizationSlug] });
    },
  });
  const undoSnooze = useMutation({
    mutationFn: (bundleId: string) => unsnoozeBundle(api, organizationSlug, bundleId),
    onSuccess: (_result, bundleId) => {
      setSnoozedNotice(null);
      if (selectedId === bundleId) setSelectedId(null);
      return queryClient.invalidateQueries({ queryKey: ['inbox', organizationSlug] });
    },
  });
  // A21: Done clears a card for good (until it is moved back); the notice offers Undo, as Snooze's.
  const done = useMutation({
    mutationFn: (bundleId: string) => markBundleDone(api, organizationSlug, bundleId),
    onSuccess: (_result, bundleId) => {
      setSnoozeMenuFor(null);
      setSnoozedNotice({ bundleId, text: t('InboxScreen.doneNotice') });
      if (selectedId === bundleId) setSelectedId(null);
      return queryClient.invalidateQueries({ queryKey: ['inbox', organizationSlug] });
    },
  });
  // In the Snoozed and Done views a card is one the member cleared: it offers the way back.
  const cleared = mode === 'snoozed' || mode === 'done';

  const markReadProps = (item: InboxItem) => ({
    loading: markRead.isPending && markRead.variables === item.bundleId,
    loadingLabel: t('InboxScreen.markingRead'),
    onClick: () => markRead.mutate(item.bundleId),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="inbox"
      title={t('InboxScreen.title')}
      {...(unreadBundles > 0
        ? {
            titleMeta: (
              <span className="tm-inbox-badge">{`${unreadBundles} ${t('InboxScreen.unread')}`}</span>
            ),
          }
        : {})}
    >
      <div className="tm-inbox">
        <div className="tm-inbox__alerts">
          {inbox.isError ? (
            <InlineAlert tone="danger" title={t('InboxScreen.loadErrorTitle')} live>
              {describe(inbox.error)}
            </InlineAlert>
          ) : null}

          {markRead.isError ? (
            <InlineAlert tone="danger" title={t('InboxScreen.markErrorTitle')} live>
              {describe(markRead.error)}
            </InlineAlert>
          ) : null}

          {snooze.isError || undoSnooze.isError || done.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('InboxScreen.snoozeErrorTitle', 'Could not snooze that item')}
              live
            >
              {describe(snooze.error ?? undoSnooze.error ?? done.error)}
            </InlineAlert>
          ) : null}

          {snoozedNotice ? (
            <div className="tm-inbox-confirm" role="status">
              <span className="tm-inbox-confirm__text">{snoozedNotice.text}</span>
              <button
                type="button"
                className="tm-inbox-confirm__undo"
                disabled={undoSnooze.isPending}
                onClick={() => undoSnooze.mutate(snoozedNotice.bundleId)}
              >
                {tOr('InboxScreen.undo', 'Undo')}
              </button>
            </div>
          ) : null}
        </div>

        <div className="tm-inbox__list">
          <section aria-labelledby="tm-inbox-modes">
            <h2 id="tm-inbox-modes" className="tm-visually-hidden">
              {t('InboxScreen.showHeading')}
            </h2>
            <div
              className="tm-chip-row tm-inbox-modes"
              role="group"
              aria-label={t('InboxScreen.modeGroupLabel')}
            >
              {MODES.map((candidate) => (
                <ModeButton
                  key={candidate.id}
                  id={candidate.id}
                  label={t(candidate.labelKey)}
                  active={mode === candidate.id}
                  onSelect={selectMode}
                />
              ))}
            </div>
          </section>

          {inbox.isPending ? (
            <LoadingRegion label={t('InboxScreen.loading')}>
              <Skeleton height="160px" />
              <Skeleton height="140px" />
            </LoadingRegion>
          ) : null}

          {/*
            "Nothing" is only said when the API has said it: a page can come back short — every
            bundle on it dropped because its object is no longer this person's to see — while a
            cursor beneath it says there is more. That is "nothing on this page", not "nothing".
          */}
          {/*
            55-10p: the unfiltered list, truly empty, teaches what the inbox is for. The other
            modes are filters over it, so an empty one keeps its own "nothing here" line.
          */}
          {!inbox.isPending &&
          !inbox.isError &&
          bundles.length === 0 &&
          !inbox.hasNextPage &&
          mode === 'all' ? (
            <TeachingEmptyState
              title={t(EMPTY_TITLE_KEYS.all)}
              explanation={t(EMPTY_BODY_KEYS.all)}
              action={
                canUse('people.invite') ? (
                  <Link
                    className="tm-button tm-button--lime tm-button--accessible"
                    href={`/${organizationSlug}/people`}
                  >
                    {t('EmptyStates.inviteTeam')}
                  </Link>
                ) : undefined
              }
              helpSlug="invite-your-team"
              helpLabel={t('EmptyStates.howInvitingWorks')}
            />
          ) : null}

          {!inbox.isPending &&
          !inbox.isError &&
          bundles.length === 0 &&
          !inbox.hasNextPage &&
          mode !== 'all' ? (
            <div className="tm-inbox-caught-up">
              <span className="tm-inbox-orb tm-inbox-orb--quiet" aria-hidden="true">
                ✓
              </span>
              <div className="tm-inbox-caught-up__text">
                <p className="tm-inbox-caught-up__title">{t(EMPTY_TITLE_KEYS[mode])}</p>
                <p>{t(EMPTY_BODY_KEYS[mode])}</p>
              </div>
            </div>
          ) : null}

          {!inbox.isPending && !inbox.isError && bundles.length === 0 && inbox.hasNextPage ? (
            <p className="tm-inbox-pagenote">{t('InboxScreen.pagenote')}</p>
          ) : null}

          {bundles.length > 0 ? (
            <ul className="tm-inbox-cards" aria-label={t('InboxScreen.bundlesLabel')}>
              {bundles.map((item) => {
                const isSelected = item.bundleId === selected?.bundleId;
                const name =
                  item.objectType === 'organization_usage'
                    ? t('InboxScreen.storageUsage')
                    : item.title;
                return (
                  <li key={item.bundleId}>
                    <article
                      className="tm-inbox-card"
                      data-selected={isSelected ? 'true' : undefined}
                      aria-labelledby={`tm-inbox-card-${cssId(item.bundleId)}`}
                    >
                      <div className="tm-inbox-card__head">
                        <span className={orbClass(item)} aria-hidden="true">
                          {glyphOf(item)}
                        </span>
                        <span className="tm-inbox-card__who">
                          {item.objectType === 'organization_usage'
                            ? t('InboxScreen.storageUsage')
                            : describeWhy(item, t)}
                        </span>
                        <time
                          className="tm-inbox-card__when"
                          dateTime={item.latestAt}
                          title={formatInstant(item.latestAt)}
                        >
                          {now ? shortAgo(item.latestAt, now) : ''}
                        </time>
                      </div>

                      <h2
                        className="tm-inbox-card__title"
                        id={`tm-inbox-card-${cssId(item.bundleId)}`}
                      >
                        {item.objectType === 'organization_usage' ? (
                          describeUsage(item, t)
                        ) : (
                          <Link href={hrefOf(organizationSlug, item)}>{item.title}</Link>
                        )}
                      </h2>

                      <p className="tm-inbox-card__body">
                        <span>
                          {item.count}{' '}
                          {item.count === 1
                            ? t('InboxScreen.updateWord')
                            : t('InboxScreen.updatesWord')}
                        </span>
                        {item.unreadCount > 0 ? (
                          <span className="tm-inbox-card__unread">
                            {item.unreadCount} {t('InboxScreen.unread')}
                          </span>
                        ) : null}
                      </p>

                      {item.objectType === 'organization_usage' ? (
                        <div className="tm-inbox-track">
                          <StateCapsule state={usageCapsule(item.band)}>
                            {`${item.band}%`}
                          </StateCapsule>
                        </div>
                      ) : (
                        <div className="tm-inbox-track">
                          {item.types.map((type) => (
                            <span key={type} className="tm-inbox-track__step">
                              {whyText(type, t)}
                            </span>
                          ))}
                          <span className="tm-inbox-track__arrow" aria-hidden="true">
                            →
                          </span>
                          <StateCapsule state={capsuleOf(item)}>{labelOf(item, t)}</StateCapsule>
                        </div>
                      )}

                      <div className="tm-inbox-card__actions">
                        {item.objectType === 'organization_usage' ? null : (
                          <Link
                            href={hrefOf(organizationSlug, item)}
                            className="tm-button tm-button--ink tm-button--compact"
                            aria-label={`${t('InboxScreen.openAriaPrefix')} ${item.title}`}
                          >
                            {t('InboxScreen.openLink')}
                          </Link>
                        )}
                        {/* The same inline action on every row: a usage notice has no object to
                            open, but it can be dismissed. Wired to the same client call and the
                            same unread guard, so it greys away after the refetch just as an
                            object bundle's does. */}
                        {item.unreadCount > 0 ? (
                          <Button
                            tone="outline"
                            size="compact"
                            aria-label={`${t('InboxScreen.markReadAriaPrefix')} ${name}`}
                            {...markReadProps(item)}
                          >
                            {t('InboxScreen.markRead')}
                          </Button>
                        ) : null}
                        {cleared ? (
                          <Button
                            tone="outline"
                            size="compact"
                            aria-label={`${t('InboxScreen.unsnoozeAriaPrefix')} ${name}`}
                            loading={undoSnooze.isPending && undoSnooze.variables === item.bundleId}
                            loadingLabel={t('InboxScreen.unsnoozing')}
                            onClick={() => undoSnooze.mutate(item.bundleId)}
                          >
                            {t(
                              mode === 'done' ? 'InboxScreen.moveToInbox' : 'InboxScreen.unsnooze',
                            )}
                          </Button>
                        ) : null}
                        {item.objectType === 'organization_usage' || mode === 'done' ? null : (
                          <Button
                            tone="outline"
                            size="compact"
                            aria-label={`${t('InboxScreen.doneAriaPrefix')} ${name}`}
                            loading={done.isPending && done.variables === item.bundleId}
                            loadingLabel={t('InboxScreen.markingDone')}
                            onClick={() => done.mutate(item.bundleId)}
                          >
                            {t('InboxScreen.done')}
                          </Button>
                        )}
                        {item.objectType === 'organization_usage' || cleared ? null : (
                          <div className="tm-inbox-snooze">
                            <Button
                              tone="outline"
                              size="compact"
                              aria-haspopup="menu"
                              aria-expanded={snoozeMenuFor === item.bundleId}
                              aria-label={`${tOr('InboxScreen.snoozeAriaPrefix', 'Snooze:')} ${name}`}
                              onClick={() =>
                                setSnoozeMenuFor((open) =>
                                  open === item.bundleId ? null : item.bundleId,
                                )
                              }
                            >
                              {`${tOr('InboxScreen.snooze', 'Snooze')} ▾`}
                            </Button>
                            {snoozeMenuFor === item.bundleId ? (
                              <div
                                className="tm-inbox-snooze__menu"
                                role="menu"
                                aria-label={tOr('InboxScreen.snoozeUntil', 'Snooze until')}
                              >
                                <p className="tm-inbox-snooze__label" aria-hidden="true">
                                  {tOr('InboxScreen.snoozeUntil', 'Snooze until')}
                                </p>
                                {SNOOZE_HORIZONS.map((horizon) => (
                                  <button
                                    key={horizon.hours}
                                    type="button"
                                    role="menuitem"
                                    className="tm-inbox-snooze__item"
                                    disabled={snooze.isPending}
                                    onClick={() =>
                                      snooze.mutate({
                                        bundleId: item.bundleId,
                                        hours: horizon.hours,
                                      })
                                    }
                                  >
                                    {tOr(horizon.key, horizon.english)}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        )}
                        <button
                          type="button"
                          className="tm-inbox-textlink"
                          aria-pressed={isSelected}
                          aria-label={`${t('InboxScreen.detailsAriaPrefix')} ${name}`}
                          onClick={() => setSelectedId(item.bundleId)}
                        >
                          {t('InboxScreen.details')}
                        </button>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {bundles.length > 0 && !inbox.hasNextPage && !inbox.isPending ? (
            <div className="tm-inbox-caught-up">
              <span className="tm-inbox-orb tm-inbox-orb--quiet" aria-hidden="true">
                ✓
              </span>
              <div className="tm-inbox-caught-up__text">
                {mode === 'all' ? (
                  <p>{t('InboxScreen.caughtUpAll')}</p>
                ) : (
                  <p>
                    {t('InboxScreen.caughtUpOtherPrefix')}{' '}
                    <button
                      type="button"
                      className="tm-inbox-textlink"
                      onClick={() => selectMode('all')}
                    >
                      {t('InboxScreen.allEventsLink')}
                    </button>
                    {t('InboxScreen.caughtUpOtherSuffix')}
                  </p>
                )}
              </div>
            </div>
          ) : null}

          {inbox.hasNextPage ? (
            <div className="tm-inbox-more">
              <Button
                tone="outline"
                size="compact"
                loading={inbox.isFetchingNextPage}
                loadingLabel={t('InboxScreen.loadingMore')}
                onClick={() => void inbox.fetchNextPage()}
              >
                {t('InboxScreen.loadMore')}
              </Button>
            </div>
          ) : null}
        </div>

        {selected ? (
          <BundleDetail
            item={selected}
            organizationSlug={organizationSlug}
            now={now}
            markRead={markReadProps(selected)}
          />
        ) : null}
      </div>

      {/*
        WCAG 2.2 4.1.3: "Load more" appends cards to a list that is in no live region, so a
        screen-reader user hears nothing when a page arrives. Announcing the running total into
        the shell's live region tells them the press did something.
      */}
      <Announce
        message={
          (inbox.data?.pages.length ?? 0) > 1 && !inbox.isFetchingNextPage
            ? `${bundles.length} ${bundles.length === 1 ? t('InboxScreen.notification') : t('InboxScreen.notifications')} ${t('InboxScreen.loadedInTotal')}`
            : ''
        }
      />
    </AppShell>
  );
}

interface BundleDetailProps {
  item: InboxItem;
  organizationSlug: string;
  now: Date | null;
  markRead: { loading: boolean; loadingLabel: string; onClick: () => void };
}

/**
 * IN-05, the bundle detail beside the list. It restates only what the bundle carries — the
 * events in words, the current state, the counts and the latest time — because there is no
 * endpoint for a bundle's history, its client projection or its consequence yet.
 */
function BundleDetail({ item, organizationSlug, now, markRead }: BundleDetailProps) {
  const t = useT();
  const ago = now ? shortAgo(item.latestAt, now) : '';
  const updates = `${item.count} ${item.count === 1 ? t('InboxScreen.updateWord') : t('InboxScreen.updatesWord')}`;

  if (item.objectType === 'organization_usage') {
    const held = item.used + item.reserved;
    return (
      <section className="tm-inbox-detail" aria-labelledby="tm-inbox-detail-title">
        <div className="tm-inbox-detail__head">
          <div className="tm-inbox-detail__titles">
            <p className="tm-inbox-eyebrow">{`${t('InboxScreen.bundleWord')} · ${t('InboxScreen.storageUsage')}`}</p>
            <h2 className="tm-inbox-detail__title" id="tm-inbox-detail-title">
              {`${t('InboxScreen.storageReachedPrefix')} ${item.band}% ${t('InboxScreen.storageReachedSuffix')}`}
            </h2>
          </div>
        </div>
        <div className="tm-inbox-detail__grid">
          <div className="tm-inbox-detail__main">
            <div className="tm-inbox-detail__card">
              <h3 className="tm-inbox-detail__card-title">{t('InboxScreen.whereItStands')}</h3>
              <p className="tm-inbox-detail__mono">
                {`${formatBytes(held)} ${t('InboxScreen.heldOfA')} ${formatBytes(item.quota)} ${t('InboxScreen.quotaMid')} ${formatBytes(item.reserved)} ${t('InboxScreen.reservedByUploads')}`}
              </p>
            </div>
            {item.unreadCount > 0 ? (
              <div className="tm-inbox-detail__actions">
                <Button tone="outline" {...markRead}>
                  {t('InboxScreen.markRead')}
                </Button>
              </div>
            ) : null}
          </div>
          <div className="tm-inbox-detail__aside">
            <div className="tm-inbox-ink">
              <p className="tm-inbox-eyebrow">{t('InboxScreen.storageBand')}</p>
              <div className="tm-inbox-ink__figure">
                <span className="tm-inbox-ink__value">{`${item.band}%`}</span>
                <p className="tm-inbox-ink__muted">{t('InboxScreen.ofQuotaInUse')}</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const kind = kindText(item.objectType, t);
  const href = hrefOf(organizationSlug, item);
  return (
    <section className="tm-inbox-detail" aria-labelledby="tm-inbox-detail-title">
      <div className="tm-inbox-detail__head">
        <div className="tm-inbox-detail__titles">
          <p className="tm-inbox-eyebrow">
            {`${t('InboxScreen.bundleWord')} · ${kind} · ${item.types.map((type) => whyText(type, t)).join(', ')}`}
          </p>
          <h2 className="tm-inbox-detail__title" id="tm-inbox-detail-title">
            {item.title}
          </h2>
        </div>
        <div className="tm-inbox-detail__tools">
          <Link
            href={href}
            className="tm-inbox-detail__tool"
            aria-label={`${t('InboxScreen.goToThe')} ${kind.toLowerCase()}`}
          >
            ⇱
          </Link>
        </div>
      </div>

      <div className="tm-inbox-detail__track">
        {item.types.map((type) => (
          <span key={type} className="tm-inbox-detail__step">
            {whyText(type, t)}
          </span>
        ))}
        <div className="tm-inbox-detail__now">
          <strong>{labelOf(item, t)}</strong>
          <span>{ago ? `${ago} · ${updates}` : updates}</span>
        </div>
      </div>

      <div className="tm-inbox-detail__grid">
        <div className="tm-inbox-detail__main">
          <div className="tm-inbox-detail__card">
            <h3 className="tm-inbox-detail__card-title">{t('InboxScreen.whatHappened')}</h3>
            <ul className="tm-inbox-detail__inset">
              {item.types.map((type) => (
                <li key={type} className="tm-inbox-detail__event">
                  <span className={orbClass(item)} aria-hidden="true">
                    {glyphOf(item)}
                  </span>
                  {whyText(type, t)}
                </li>
              ))}
              <li>
                <p className="tm-inbox-detail__mono">
                  {`${updates} · ${t('InboxScreen.latest')} ${formatInstant(item.latestAt)}`}
                </p>
              </li>
            </ul>
            {item.objectType === 'client_request' ? (
              <p className="tm-inbox-detail__note">
                <span className="tm-inbox-orb" aria-hidden="true">
                  ◎
                </span>
                {t('InboxScreen.fromClientNote')}
              </p>
            ) : null}
          </div>

          <div className="tm-inbox-detail__actions">
            <Link href={href} className="tm-button tm-button--ink">
              {`${t('InboxScreen.openWord')} ${openNounText(item.objectType, t)}`}
            </Link>
            {item.unreadCount > 0 ? (
              <Button tone="outline" {...markRead}>
                {t('InboxScreen.markRead')}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="tm-inbox-detail__aside">
          <div className="tm-inbox-ink">
            <p className="tm-inbox-eyebrow">{t('InboxScreen.stillUnread')}</p>
            <div className="tm-inbox-ink__figure">
              <span className="tm-inbox-ink__value">{item.unreadCount}</span>
              <p className="tm-inbox-ink__muted">{`${t('InboxScreen.ofWord')} ${updates}`}</p>
            </div>
            <span className="tm-inbox-ink__rule" aria-hidden="true" />
            <p className="tm-inbox-eyebrow">{t('InboxScreen.events')}</p>
            <ul className="tm-inbox-ink__list">
              {item.types.map((type) => (
                <li key={type} className="tm-inbox-ink__item">
                  <span className="tm-inbox-ink__glyph" aria-hidden="true">
                    {glyphOf(item)}
                  </span>
                  {whyText(type, t)}
                </li>
              ))}
            </ul>
          </div>
          <div className="tm-inbox-why">
            <p className="tm-inbox-eyebrow">{t('InboxScreen.whyReachedYou')}</p>
            <p>{reasonOf(item, t)}</p>
            <Link href={`/${organizationSlug}/inbox/rules`}>
              {t('InboxScreen.tuneWhatReaches')}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

type Translate = (key: MessageKey) => string;

const MODES: readonly { readonly id: InboxMode; readonly labelKey: MessageKey }[] = [
  { id: 'important', labelKey: 'InboxScreen.modeImportant' },
  { id: 'all', labelKey: 'InboxScreen.modeAll' },
  { id: 'waiting_on_me', labelKey: 'InboxScreen.modeWaitingOnMe' },
  { id: 'client_actions', labelKey: 'InboxScreen.modeClient' },
  { id: 'snoozed', labelKey: 'InboxScreen.modeSnoozed' },
  { id: 'done', labelKey: 'InboxScreen.modeDone' },
];

const EMPTY_TITLE_KEYS: Record<InboxMode, MessageKey> = {
  important: 'InboxScreen.emptyTitleImportant',
  all: 'InboxScreen.emptyTitleAll',
  waiting_on_me: 'InboxScreen.emptyTitleWaiting',
  client_actions: 'InboxScreen.emptyTitleClient',
  snoozed: 'InboxScreen.emptyTitleSnoozed',
  done: 'InboxScreen.emptyTitleDone',
};

const EMPTY_BODY_KEYS: Record<InboxMode, MessageKey> = {
  important: 'InboxScreen.emptyBodyImportant',
  all: 'InboxScreen.emptyBodyAll',
  waiting_on_me: 'InboxScreen.emptyBodyWaiting',
  client_actions: 'InboxScreen.emptyBodyClient',
  snoozed: 'InboxScreen.emptyBodySnoozed',
  done: 'InboxScreen.emptyBodyDone',
};

/** The event types this half of INBOX-001 knows, said in words. Unknown types are shown as is. */
const WHY_KEYS: Record<string, MessageKey> = {
  'work_item.blocked.v1': 'InboxScreen.whyBlocked',
  'client_request.submitted.v1': 'InboxScreen.whyClientSubmitted',
  'client_request.transitioned.v1': 'InboxScreen.whyRequestAnswered',
  'client_request.reopened.v1': 'InboxScreen.whyRequestReopened',
  'message.mentioned.v1': 'InboxScreen.whyMentioned',
  'document.mentioned.v1': 'InboxScreen.whyMentionedComment',
  'document.comment_created.v1': 'InboxScreen.whyNewComment',
  'meeting.attendee_invited.v1': 'InboxScreen.whyInvited',
  'project.member_added.v1': 'InboxScreen.whyAdded',
  'automation.notified.v1': 'InboxScreen.whyAutomation',
  'automation.test_run.v1': 'InboxScreen.whyTestRun',
  // R4 slice 12 — a file under review.
  'review.comment_added.v1': 'InboxScreen.whyReviewComment',
  'review.replied.v1': 'InboxScreen.whyReviewReplied',
  'review.mentioned.v1': 'InboxScreen.whyReviewMentioned',
  'review.thread_resolved.v1': 'InboxScreen.whyReviewResolved',
  'review.thread_reopened.v1': 'InboxScreen.whyReviewReopened',
  'review.approved.v1': 'InboxScreen.whyReviewApproved',
  'review.changes_requested.v1': 'InboxScreen.whyReviewChangesRequested',
};

/**
 * Fix 2026-11-09: types whose keys reach the catalogs through an i18n fragment — said through
 * `translateOr` (English until the merge) so the typed map above stays `MessageKey`-only.
 */
const WHY_FALLBACKS: Record<string, { readonly key: string; readonly english: string }> = {
  'meeting.attendee_responded.v1': {
    key: 'InboxScreen.whyMeetingResponded',
    english: 'Someone answered from their calendar',
  },
};

/** An event type said in words, falling back to the raw type for one this build does not know. */
function whyText(type: string, t: Translate): string {
  const key = WHY_KEYS[type];
  if (key) return t(key);
  const fallback = WHY_FALLBACKS[type];
  return fallback ? translateOr(fallback.key, fallback.english) : type;
}

/** What each kind of bundle is called on screen. */
const KIND_KEYS: Record<InboxBundle['objectType'], MessageKey> = {
  work_item: 'InboxScreen.kindWorkItem',
  client_request: 'InboxScreen.kindClientRequest',
  conversation: 'InboxScreen.kindConversation',
  document: 'InboxScreen.kindDocument',
  meeting: 'InboxScreen.kindMeeting',
  project: 'InboxScreen.kindProject',
  workflow_template: 'InboxScreen.kindWorkflowTemplate',
  file_asset: 'InboxScreen.kindFile',
};

function kindText(objectType: InboxBundle['objectType'], t: Translate): string {
  return t(KIND_KEYS[objectType]);
}

/** The noun after "Open" on the detail's button. */
const OPEN_NOUN_KEYS: Record<InboxBundle['objectType'], MessageKey> = {
  work_item: 'InboxScreen.openWorkItem',
  client_request: 'InboxScreen.openClientRequest',
  conversation: 'InboxScreen.openConversation',
  document: 'InboxScreen.openDocument',
  meeting: 'InboxScreen.openMeeting',
  project: 'InboxScreen.openProject',
  workflow_template: 'InboxScreen.openWorkflowTemplate',
  file_asset: 'InboxScreen.openFile',
};

function openNounText(objectType: InboxBundle['objectType'], t: Translate): string {
  return t(OPEN_NOUN_KEYS[objectType]);
}

function describeWhy(bundle: InboxBundle, t: Translate): string {
  const words = bundle.types.map((type) => whyText(type, t));
  return `${kindText(bundle.objectType, t)} · ${words.join(', ')}`;
}

/**
 * The API bundles one page at a time, so an object whose rows straddle a page boundary
 * arrives twice — once per page, each with its own count. Two rows with one bundle id is two
 * React keys that collide and a title a reader sees twice, so the pages are folded into one
 * list here: counts add, unread counts add, types union, the newest time wins, and the row
 * keeps the place of its first (newest) appearance.
 */
function mergePages(pages: readonly (readonly InboxItem[])[]): readonly InboxItem[] {
  const byId = new Map<string, InboxItem>();
  for (const page of pages) {
    for (const item of page) {
      const seen = byId.get(item.bundleId);
      if (!seen) {
        byId.set(item.bundleId, item);
        continue;
      }
      byId.set(item.bundleId, mergeItem(seen, item));
    }
  }
  return [...byId.values()];
}

function mergeItem(seen: InboxItem, next: InboxItem): InboxItem {
  const count = seen.count + next.count;
  const unreadCount = seen.unreadCount + next.unreadCount;
  const latestAt = seen.latestAt >= next.latestAt ? seen.latestAt : next.latestAt;
  // Same bundle id means the same object, so a usage notice never merges with an object bundle.
  // A usage notice carries no `types`; keep the freshest read's counters.
  if (seen.objectType === 'organization_usage' || next.objectType === 'organization_usage') {
    const fresher = seen.latestAt >= next.latestAt ? seen : next;
    return { ...fresher, count, unreadCount, latestAt } as InboxItem;
  }
  const types = [...seen.types];
  for (const type of next.types) if (!types.includes(type)) types.push(type);
  return { ...seen, count, unreadCount, types, latestAt };
}

/** "Storage at 85 % — 8.5 GB of 10 GB": the band, then used+reserved of quota (35 §1's copy). */
function describeUsage(notice: InboxUsageNotice, t: Translate): string {
  const held = notice.used + notice.reserved;
  return `${t('InboxScreen.storageAt')} ${notice.band}% — ${formatBytes(held)} ${t('InboxScreen.ofWord')} ${formatBytes(notice.quota)}`;
}

/** A capsule state for a threshold band, within the palette the matrix draws. */
function usageCapsule(band: number): CapsuleState {
  if (band >= 100) return 'blocked';
  if (band >= 70) return 'waiting';
  return 'neutral';
}

/** Bytes as a short human string, binary units — "8.5 GB", "512 MB". */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${units[unit]}`;
}

function hrefOf(organizationSlug: string, bundle: InboxBundle): string {
  switch (bundle.objectType) {
    case 'work_item':
      return `/${organizationSlug}/work/${bundle.objectId}`;
    case 'client_request':
      return `/${organizationSlug}/work/requests/${bundle.objectId}`;
    case 'conversation':
      return `/${organizationSlug}/chat/${bundle.objectId}`;
    case 'document':
      return `/${organizationSlug}/docs/${bundle.objectId}`;
    case 'meeting':
      return `/${organizationSlug}/calendar/meetings/${bundle.objectId}`;
    case 'project':
      return `/${organizationSlug}/projects/${bundle.objectId}`;
    case 'workflow_template':
      return `/${organizationSlug}/automations/templates/${bundle.objectId}`;
    case 'file_asset':
      return `/${organizationSlug}/files/${bundle.objectId}`;
  }
}

/**
 * The state came through the object's own read, so it is one of that object's states — but the
 * wire type is a string, and a guard is cheaper than trusting it. An unknown state is shown
 * verbatim in a neutral capsule rather than crashing the row.
 */
function capsuleOf(bundle: InboxBundle): CapsuleState {
  if (bundle.objectType === 'work_item' && isWorkItemState(bundle.state)) {
    return stateCapsule(bundle.state);
  }
  if (bundle.objectType === 'client_request' && isClientRequestState(bundle.state)) {
    return triageStateCapsule(bundle.state);
  }
  return 'neutral';
}

function labelOf(bundle: InboxBundle, t: Translate): string {
  if (bundle.objectType === 'work_item' && isWorkItemState(bundle.state)) {
    return stateLabel(bundle.state);
  }
  if (bundle.objectType === 'client_request' && isClientRequestState(bundle.state)) {
    return triageStateLabel(bundle.state);
  }
  const key = STATE_WORD_KEYS[bundle.state];
  return key ? t(key) : bundle.state;
}

/** The state words the collaboration bundles carry, said plainly. */
const STATE_WORD_KEYS: Record<string, MessageKey> = {
  active: 'InboxScreen.stateActive',
  archived: 'InboxScreen.stateArchived',
  document: 'InboxScreen.stateDocument',
  meeting: 'InboxScreen.stateMeeting',
  live: 'InboxScreen.stateLive',
  off: 'InboxScreen.stateOff',
  file: 'InboxScreen.stateFile',
};

function isWorkItemState(value: string): value is WorkItemState {
  return (WORK_ITEM_STATES as readonly string[]).includes(value);
}

function isClientRequestState(value: string): value is ClientRequestState {
  return (CLIENT_REQUEST_STATES as readonly string[]).includes(value);
}

interface ModeButtonProps {
  id: InboxMode;
  label: string;
  active: boolean;
  onSelect: (id: InboxMode) => void;
}

/**
 * `aria-pressed` rather than a tab set, for `REQ-01`'s reason: the list beneath is the same
 * list, differently filtered, not a panel swap. Painted as the frame's filter capsules; the
 * client mode keeps the violet external-boundary ring.
 */
function ModeButton({ id, label, active, onSelect }: ModeButtonProps) {
  return (
    <button
      type="button"
      className={id === 'client_actions' ? 'tm-chip tm-chip--client' : 'tm-chip'}
      aria-pressed={active}
      onClick={() => onSelect(id)}
    >
      {label}
    </button>
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

/** "now", "12m", "26h", "2d", then the short date — the frame's mono time stamps. */
function shortAgo(value: string, now: Date): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return translateOr('CompactTime.now', 'now');
  if (minutes < 60) return compactUnit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return compactUnit(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return compactUnit(days, 'day');
  return new Intl.DateTimeFormat(withNumerals(activeLocale.get()), {
    day: 'numeric',
    month: 'short',
  }).format(at);
}

/** The rail's own glyph for what the bundle is about: work, client, storage, or (CQ-12) the rest. */
function glyphOf(item: InboxItem): string {
  if (item.objectType === 'work_item') return '▤';
  if (item.objectType === 'client_request') return '◎';
  if (item.objectType === 'conversation') return '#';
  if (item.objectType === 'document') return '¶';
  if (item.objectType === 'meeting') return '◷';
  if (item.objectType === 'project') return '▦';
  if (item.objectType === 'workflow_template') return '⟳';
  if (item.objectType === 'file_asset') return '◫';
  return '◔';
}

function orbClass(item: InboxItem): string {
  if (item.objectType === 'client_request') return 'tm-inbox-orb tm-inbox-orb--client';
  if (item.objectType === 'organization_usage') return 'tm-inbox-orb tm-inbox-orb--quiet';
  return 'tm-inbox-orb';
}

/** A bundle id (`work_item:wi-1`) as a safe element id fragment. */
function cssId(bundleId: string): string {
  return bundleId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** Why the bundle reached this person, from the event types it holds — nothing inferred. */
function reasonOf(bundle: InboxBundle, t: Translate): string {
  const reasons: string[] = [];
  if (bundle.types.includes('work_item.blocked.v1')) {
    reasons.push(t('InboxScreen.reasonBlocked'));
  }
  if (bundle.types.includes('client_request.submitted.v1')) {
    reasons.push(t('InboxScreen.reasonClientSubmitted'));
  }
  if (bundle.types.includes('client_request.transitioned.v1')) {
    reasons.push(t('InboxScreen.reasonRequestAnswered'));
  }
  if (
    bundle.types.includes('message.mentioned.v1') ||
    bundle.types.includes('document.mentioned.v1')
  ) {
    reasons.push(t('InboxScreen.reasonMentioned'));
  }
  if (bundle.types.includes('document.comment_created.v1')) {
    reasons.push(t('InboxScreen.reasonComment'));
  }
  if (bundle.types.includes('meeting.attendee_invited.v1')) {
    reasons.push(t('InboxScreen.reasonInvited'));
  }
  if (bundle.types.includes('project.member_added.v1')) {
    reasons.push(t('InboxScreen.reasonAdded'));
  }
  if (bundle.types.includes('meeting.attendee_responded.v1')) {
    reasons.push(
      translateOr(
        'InboxScreen.reasonMeetingResponded',
        'You organize this meeting, and an attendee answered it in Google Calendar or Outlook.',
      ),
    );
  }
  if (bundle.types.includes('automation.notified.v1')) {
    reasons.push(t('InboxScreen.reasonAutomation'));
  }
  if (bundle.types.includes('automation.test_run.v1')) {
    reasons.push(t('InboxScreen.reasonTestRun'));
  }
  if (bundle.types.includes('review.mentioned.v1')) {
    reasons.push(t('InboxScreen.reasonReviewMentioned'));
  }
  if (
    bundle.types.includes('review.comment_added.v1') ||
    bundle.types.includes('review.replied.v1') ||
    bundle.types.includes('review.thread_resolved.v1') ||
    bundle.types.includes('review.thread_reopened.v1')
  ) {
    reasons.push(t('InboxScreen.reasonReviewComment'));
  }
  if (
    bundle.types.includes('review.approved.v1') ||
    bundle.types.includes('review.changes_requested.v1')
  ) {
    reasons.push(t('InboxScreen.reasonReviewDecision'));
  }
  if (reasons.length === 0) reasons.push(t('InboxScreen.reasonDefault'));
  return reasons.join(' ');
}

const INBOX_MODES: readonly InboxMode[] = [
  'important',
  'all',
  'waiting_on_me',
  'client_actions',
  'snoozed',
  'done',
];

function isInboxMode(value: string): value is InboxMode {
  return (INBOX_MODES as readonly string[]).includes(value);
}

/** The card's snooze horizons, as designed (Inbox · Card actions, 2026-10-31 live-test fix). */
const SNOOZE_HORIZONS: readonly { key: string; english: string; hours: number }[] = [
  { key: 'InboxScreen.snoozeLaterToday', english: 'Later today · in 3 hours', hours: 3 },
  { key: 'InboxScreen.snoozeTomorrow', english: 'Tomorrow', hours: 24 },
  { key: 'InboxScreen.snoozeNextWeek', english: 'Next week', hours: 24 * 7 },
];

function snoozedText(hours: number, tOr: (key: string, english: string) => string): string {
  if (hours <= 3) {
    return tOr(
      'InboxScreen.snoozedLaterToday',
      'Snoozed for 3 hours. It comes back to your inbox then.',
    );
  }
  if (hours <= 24) {
    return tOr(
      'InboxScreen.snoozedTomorrow',
      'Snoozed until tomorrow. It comes back to your inbox then.',
    );
  }
  return tOr(
    'InboxScreen.snoozedNextWeek',
    'Snoozed for a week. It comes back to your inbox then.',
  );
}
