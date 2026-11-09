'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell, DayPulseBar } from '../shell/AppShell';
import type { DayPulseItem } from '../shell/AppShell';
import { HomeHeroSection } from './HomeHeroSection';
import { HomePinnedSection } from './HomePinnedSection';
import { HomeRecentItemsView } from './HomeRecentItemsView';
import { PhoneHomeHero } from '../phone/PhoneHomeHero';
import type { PhoneUpNext } from '../phone/PhoneHomeHero';
import { PhoneIcon } from '../icons/phone';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomeSummary, getMyDay, getSavedContext, getWaiting } from '../../lib/api/home';
import type {
  HomeSummary,
  MyDay,
  MyDayReason,
  SavedContextEntityType,
  Waiting,
  WaitingReason,
} from '../../lib/api/home';
import { listProjects } from '../../lib/api/projects';
import { getCalendarGrid } from '../../lib/api/calendar-grid';
import { listFocusBlocks } from '../../lib/api/focus-blocks';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiErrorLines } from '../../lib/api/describe-error';
import { formatDay, stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { translateOr } from '../../lib/i18n/compact-time';
import { withNumerals } from '../../lib/i18n/display-format';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { countNoun } from '../../lib/i18n/plural';
import { fill } from '../../lib/privacy-presentation';
import { MY_WORK_TOPIC, useWorkLiveRefresh } from '../../lib/use-work-live-refresh';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/home.css';
import { CoachMarkTour } from '../help/CoachMarkTour';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { useTOr } from '../../lib/i18n/use-t-or';

export interface MyDayScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

type MyDayEntry = MyDay['items'][number];
type WaitingEntry = Waiting['items'][number];
type CardFilter = 'all' | 'overdue' | 'due_soon';

/**
 * **HOME-01 My Day** — the first destination on the internal rail, drawn to the design handoff's
 * HOME-01 frame: the black day capsule, the 64px "MY DAY" display headline with its "New work"
 * capsule and three header metrics, the black Focus Capsule naming the one thing to do next,
 * "Due & at risk" as bento cards (the first one lime), "Waiting on you" as a row list, the
 * HOME-03 personal-work list grouped by project, and — in the right column — the HOME-05 saved
 * context (Saved, Pinned, Recently viewed).
 *
 * ## A faithful reader
 *
 * Every number, title and row comes from the API: `/home/my-day` ranks the acting user's own open
 * work (overdue → due soon → the rest) and names a reason per row; `/home/waiting` lists
 * approvals pending on them and client requests awaiting triage; `/home/summary` and
 * `/home/pulse` are the derived counts. The day capsule shows only real meetings and focus
 * blocks for today. Where the design shows data the API does not have yet (owner names on a
 * card, the project context lens, delegated "waiting on others") the screen draws what it does
 * know rather than inventing it.
 */
export function MyDayScreen({ organizationSlug, organizationName, client }: MyDayScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const describeError = useDescribeApiError(WORK_ERROR_LINES);
  const describeWaitingError = useDescribeApiError(WAITING_ERROR_LINES);
  const describeSavedError = useDescribeApiError(SAVED_ERROR_LINES);
  const describeSummaryError = useDescribeApiError(SUMMARY_ERROR_LINES);
  const [filter, setFilter] = useState<CardFilter>('all');

  // 53-01: My Day refetches when the person's own work changes elsewhere (created, moved,
  // edited, commented, assigned), over the personal `me` topic.
  const queryClient = useQueryClient();
  useWorkLiveRefresh({
    api,
    organizationSlug,
    topics: [MY_WORK_TOPIC],
    // A suite injects its own client and drives no socket; the live layer is the browser's.
    enabled: client === undefined,
    onChange: () => void queryClient.invalidateQueries({ queryKey: ['home'] }),
  });

  const myDay = useQuery({
    queryKey: ['home', 'my-day', organizationSlug],
    queryFn: () => getMyDay(api, organizationSlug),
  });

  const waiting = useQuery({
    queryKey: ['home', 'waiting', organizationSlug],
    queryFn: () => getWaiting(api, organizationSlug),
  });

  const summary = useQuery({
    queryKey: ['home', 'summary', organizationSlug],
    queryFn: () => getHomeSummary(api, organizationSlug),
  });

  const saved = useQuery({
    queryKey: ['home', 'saved-context', organizationSlug],
    queryFn: () => getSavedContext(api, organizationSlug),
  });

  // Names for the project each item belongs to — My Day spans every project, so an id alone
  // would not tell the reader which one. One directory, resolved through a map, no fetch per row.
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });

  const { items: pulseItems, upNext } = useDayPulseItems(api, organizationSlug);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);
  const projectName = (id: string): string =>
    projectNames.get(id) ?? t('MyDayScreen.anotherProjectCap');

  const items = useMemo(() => myDay.data?.items ?? [], [myDay.data]);
  const waitingItems = waiting.data?.items ?? [];
  const savedGroups = saved.data?.groups ?? [];

  // The My Day list is bounded on the API (H2); the counts come from the summary, which counts
  // every open item, and fall back to the list while the summary is loading or failed.
  const personalWork = summary.data?.personalWork;
  const totalCount = personalWork?.total ?? items.length;
  const overdueCount =
    personalWork?.overdue ?? items.filter((entry) => entry.reason === 'overdue').length;
  const dueSoonCount =
    personalWork?.dueSoon ?? items.filter((entry) => entry.reason === 'due_soon').length;
  const cards = items.filter((entry) => filter === 'all' || entry.reason === filter).slice(0, 3);
  const top = items[0];

  const groups = useMemo(() => groupByProject(items), [items]);

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="home"
      title={t('MyDayScreen.title')}
      titleVariant="display"
      actionsPlacement="inline"
      actions={
        <Link
          href={`/${organizationSlug}/capture`}
          className="tm-button tm-button--ink tm-button--feature"
        >
          <span className="tm-button__orb" aria-hidden="true">
            +
          </span>
          {t('MyDayScreen.newWork')}
        </Link>
      }
      description={describeDay(summary.data, summary.isPending || summary.isError, t, locale)}
      headerAside={<HomeHeroSection organizationSlug={organizationSlug} client={client} />}
      topBar={
        <DayPulseBar
          organizationSlug={organizationSlug}
          items={pulseItems}
          nowLabel={top ? top.workItem.title : t('MyDayScreen.nothingScheduled')}
        />
      }
    >
      {/* Phone (<768px) hero and "Up next" card — hidden on wider screens by phone/home.css. */}
      <PhoneHomeHero
        api={api}
        organizationSlug={organizationSlug}
        headline={dayLead(summary.data, summary.isPending || summary.isError, t, locale)}
        approvalsWaiting={summary.data?.waiting.approvals}
        upNext={upNext}
      />

      {summary.isError ? (
        <InlineAlert tone="danger" title={t('MyDayScreen.summaryError')} live>
          {describeSummaryError(summary.error)}
        </InlineAlert>
      ) : null}

      {top ? (
        <div
          className="tm-focus-capsule tm-home-focus"
          role="group"
          aria-label={t('MyDayScreen.doThisNext')}
        >
          <span className="tm-focus-capsule__orb" aria-hidden="true">
            ▸
          </span>
          <div className="tm-focus-capsule__text">
            <p className="tm-focus-capsule__title">
              <Link href={`/${organizationSlug}/work/${top.workItem.id}`}>
                {top.workItem.title}
              </Link>
            </p>
            <p className="tm-focus-capsule__why">
              {fill(t('MyDayScreen.whyNow'), {
                reason: whyNow(top, t, locale),
                project: projectName(top.workItem.projectId),
              })}
            </p>
          </div>
          <div className="tm-focus-capsule__end">
            <span className="tm-home-focus__flag">
              <span className="tm-home-focus__flag-glyph" aria-hidden="true">
                !
              </span>
              {stateLabel(top.workItem.state)}
            </span>
            <Link
              href={`/${organizationSlug}/work/${top.workItem.id}`}
              className="tm-home-focus__go"
              aria-label={`${t('MyDayScreen.openPrefix')} ${top.workItem.title}`}
            >
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      ) : null}

      <div className="tm-home-body">
        <div className="tm-home-main">
          <section className="tm-home-section" aria-labelledby="tm-my-day-personal">
            <div className="tm-section-head">
              <h2 id="tm-my-day-personal" className="tm-section-head__title">
                {t('MyDayScreen.dueAtRisk')}
              </h2>
              <span className="tm-section-head__meta tm-home-section__count">
                {totalCount}{' '}
                {countNoun(locale, totalCount, t('MyDayScreen.item'), t('MyDayScreen.items'))}
              </span>
              <span className="tm-phone-home__count" aria-hidden="true">
                {totalCount}
              </span>
              <div
                className="tm-section-head__end tm-chip-row"
                role="group"
                aria-label={t('MyDayScreen.show')}
              >
                <button
                  type="button"
                  className="tm-chip tm-chip--compact"
                  aria-pressed={filter === 'all'}
                  onClick={() => setFilter('all')}
                >
                  {t('MyDayScreen.today')}
                </button>
                <button
                  type="button"
                  className="tm-chip tm-chip--compact"
                  aria-pressed={filter === 'overdue'}
                  onClick={() => setFilter('overdue')}
                >
                  {t('MyDayScreen.overdue')} · {overdueCount}
                </button>
                <button
                  type="button"
                  className="tm-chip tm-chip--compact"
                  aria-pressed={filter === 'due_soon'}
                  onClick={() => setFilter('due_soon')}
                >
                  {t('MyDayScreen.dueSoon')} · {dueSoonCount}
                </button>
              </div>
            </div>

            {myDay.isError ? (
              <InlineAlert tone="danger" title={t('MyDayScreen.workError')} live>
                {describeError(myDay.error)}
              </InlineAlert>
            ) : null}

            {myDay.isPending ? (
              <LoadingRegion label={t('MyDayScreen.loadingWork')}>
                <Skeleton height="180px" radius="var(--r-card)" />
              </LoadingRegion>
            ) : null}

            {!myDay.isPending && !myDay.isError && items.length === 0 ? (
              <TeachingEmptyState
                title={t('MyDayScreen.nothingNeedsYouTitle')}
                explanation={t('MyDayScreen.nothingNeedsYouBody')}
                action={
                  <Link
                    className="tm-button tm-button--lime tm-button--compact"
                    href={`/${organizationSlug}/capture`}
                  >
                    {tOr('EmptyStates.newTask', 'New task')}
                  </Link>
                }
                helpSlug="create-and-assign-tasks"
                helpLabel={tOr('EmptyStates.howTasksWork', 'How tasks work')}
              />
            ) : null}

            {items.length > 0 && cards.length === 0 ? (
              <div className="tm-card tm-card--empty tm-home-empty">
                <h3 className="tm-card__title">
                  {filter === 'overdue'
                    ? t('MyDayScreen.nothingOverdue')
                    : t('MyDayScreen.nothingDueSoon')}
                </h3>
                <p className="tm-card__meta">{t('MyDayScreen.everythingElseBelow')}</p>
              </div>
            ) : null}

            {cards.length > 0 ? (
              <ul className="tm-home-cards" aria-label={t('MyDayScreen.yourWorkRanked')}>
                {cards.map((entry, index) => (
                  <li key={entry.workItem.id}>
                    <WorkCard
                      entry={entry}
                      lime={index === 0 && filter === 'all'}
                      organizationSlug={organizationSlug}
                      projectName={projectName(entry.workItem.projectId)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section
            className="tm-home-section tm-home-section--quiet"
            aria-labelledby="tm-my-day-waiting"
          >
            <div className="tm-section-head">
              <h2 id="tm-my-day-waiting" className="tm-section-head__title">
                {t('MyDayScreen.waitingOnYou')}
              </h2>
              <span className="tm-section-head__meta">{t('MyDayScreen.waitingMeta')}</span>
            </div>

            {waiting.isError ? (
              <InlineAlert tone="danger" title={t('MyDayScreen.waitingError')} live>
                {describeWaitingError(waiting.error)}
              </InlineAlert>
            ) : null}

            {waiting.isPending ? (
              <LoadingRegion label={t('MyDayScreen.loadingWaiting')}>
                <Skeleton height="44px" />
                <Skeleton height="44px" />
              </LoadingRegion>
            ) : null}

            {!waiting.isPending && !waiting.isError && waitingItems.length === 0 ? (
              <div className="tm-card tm-card--empty tm-home-empty">
                <h3 className="tm-card__title">{t('MyDayScreen.nothingWaitingTitle')}</h3>
                <p className="tm-card__meta">{t('MyDayScreen.nothingWaitingBody')}</p>
              </div>
            ) : null}

            {waitingItems.length > 0 ? (
              <ul className="tm-row-list tm-home-rows" aria-label={t('MyDayScreen.waitingOnYou')}>
                {waitingItems.map((entry) => (
                  <WaitingRow
                    key={entry.kind === 'approval' ? entry.approvalId : entry.clientRequestId}
                    entry={entry}
                    organizationSlug={organizationSlug}
                    projectName={projectName(entry.projectId)}
                  />
                ))}
              </ul>
            ) : null}
          </section>

          {groups.length > 0 ? (
            <section
              className="tm-home-section tm-home-section--quiet"
              aria-labelledby="tm-my-day-all"
            >
              <div className="tm-section-head">
                <h2 id="tm-my-day-all" className="tm-section-head__title">
                  {t('MyDayScreen.personalWork')}
                </h2>
                <span className="tm-section-head__meta">
                  {groups.length}{' '}
                  {groups.length === 1 ? t('MyDayScreen.project') : t('MyDayScreen.projects')}
                </span>
              </div>
              <ul className="tm-home-groups" aria-label={t('MyDayScreen.yourOpenWorkByProject')}>
                {groups.map((group) => (
                  <li key={group.projectId} className="tm-home-group">
                    <h3 className="tm-home-group__head">
                      <span>{projectName(group.projectId)}</span>
                      <span className="tm-home-group__count">{group.entries.length}</span>
                    </h3>
                    <ul className="tm-home-group__rows">
                      {group.entries.map((entry) => (
                        <li key={entry.workItem.id}>
                          <span className="tm-home-group__type" aria-hidden="true">
                            {typeCode(entry.workItem.type)}
                          </span>
                          <span className="tm-home-group__title">
                            <Link href={`/${organizationSlug}/work/${entry.workItem.id}`}>
                              {entry.workItem.title}
                            </Link>
                          </span>
                          <StateCapsule state={stateCapsule(entry.workItem.state)}>
                            {stateLabel(entry.workItem.state)}
                          </StateCapsule>
                          <span
                            className="tm-meta-mono tm-home-group__due"
                            data-reason={entry.reason}
                          >
                            {shortDay(entry.workItem.dueAt, locale)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>

        <div className="tm-home-side">
          <section className="tm-home-saved" aria-labelledby="tm-my-day-saved">
            <div className="tm-home-saved__head">
              <h2 id="tm-my-day-saved" className="tm-home-saved__heading">
                {t('MyDayScreen.saved')}
              </h2>
              {savedGroups.length > 0 ? (
                <span className="tm-home-saved__count">
                  {savedGroups.reduce((total, group) => total + group.items.length, 0)}{' '}
                  {t('MyDayScreen.savedCountSuffix')}
                </span>
              ) : null}
            </div>

            {saved.isError ? (
              <InlineAlert tone="danger" title={t('MyDayScreen.savedItemsError')} live>
                {describeSavedError(saved.error)}
              </InlineAlert>
            ) : null}

            {saved.isPending ? (
              <LoadingRegion label={t('MyDayScreen.loadingSaved')}>
                <Skeleton height="52px" radius="var(--r-control)" />
              </LoadingRegion>
            ) : null}

            {!saved.isPending && !saved.isError && savedGroups.length === 0 ? (
              <p className="tm-home-saved__empty">
                <strong>{t('MyDayScreen.nothingSavedTitle')}</strong>
                {t('MyDayScreen.nothingSavedBody')}
              </p>
            ) : null}

            {savedGroups.map((group) => (
              <div key={group.projectId} className="tm-home-saved__block">
                <h3 className="tm-home-saved__group">{projectName(group.projectId)}</h3>
                <ul
                  className="tm-home-saved__list"
                  aria-label={`${t('MyDayScreen.savedInPrefix')} ${projectNames.get(group.projectId) ?? t('MyDayScreen.anotherProject')}`}
                >
                  {group.items.map((item) => (
                    <li key={item.id} className="tm-home-saved__item" data-kind={item.entityType}>
                      <span className="tm-home-orb" aria-hidden="true">
                        {savedGlyph(item.entityType)}
                      </span>
                      <span className="tm-home-saved__text">
                        <span className="tm-home-saved__title">
                          {item.entityType === 'work' ? (
                            <Link href={`/${organizationSlug}/work/${item.entityId}`}>
                              {t(savedTypeLabelKey(item.entityType))}
                            </Link>
                          ) : (
                            <span>{t(savedTypeLabelKey(item.entityType))}</span>
                          )}
                        </span>
                        <span className="tm-home-saved__meta">
                          {savedKindWord(item.entityType)} · {t('MyDayScreen.savedCountSuffix')}{' '}
                          {shortDay(item.createdAt, locale)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>

          <HomePinnedSection organizationSlug={organizationSlug} client={client} />

          <HomeRecentItemsView organizationSlug={organizationSlug} client={client} />
        </div>
      </div>
      <CoachMarkTour
        organizationSlug={organizationSlug}
        tour="my_day"
        {...(client ? { client } : {})}
      />
    </AppShell>
  );
}

/** One "Due & at risk" card: the first is the lime one, the rest white (HOME-01). */
function WorkCard({
  entry,
  lime,
  organizationSlug,
  projectName,
}: {
  entry: MyDayEntry;
  lime: boolean;
  organizationSlug: string;
  projectName: string;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const href = `/${organizationSlug}/work/${entry.workItem.id}`;
  return (
    <article className={`tm-card tm-home-card${lime ? ' tm-card--lime' : ''}`}>
      <div className="tm-home-card__top">
        <span className="tm-card__eyebrow">
          <span className="tm-home-orb" aria-hidden="true">
            {typeGlyph(entry.workItem.type)}
          </span>
          <span className="tm-home-card__eyebrow-text">
            {typeWord(entry.workItem.type)} · {projectName}
          </span>
        </span>
        <span className="tm-home-orb" aria-hidden="true">
          ↗
        </span>
      </div>
      <span className="tm-phone-home-card__orb" aria-hidden="true">
        <PhoneIcon name={entry.workItem.type === 'deliverable' ? 'image' : 'work'} />
      </span>
      <h3 className="tm-card__title">
        <Link href={href}>{entry.workItem.title}</Link>
      </h3>
      <span className="tm-phone-home-card__meta">
        {projectName} ·{' '}
        {entry.workItem.dueAt
          ? `${t('MyDayScreen.due')} ${longDay(entry.workItem.dueAt, locale)}`
          : t('MyDayScreen.noDueDate')}
      </span>
      <div className="tm-home-card__foot">
        <span className="tm-card__meta">
          {entry.workItem.dueAt
            ? `${t('MyDayScreen.due')} ${shortDay(entry.workItem.dueAt, locale)}`
            : t('MyDayScreen.noDueDate')}{' '}
          · {t(reasonLabelKey(entry.reason)).toLowerCase()}
        </span>
        <StateCapsule state={stateCapsule(entry.workItem.state)}>
          {stateLabel(entry.workItem.state)}
        </StateCapsule>
      </div>
    </article>
  );
}

/** One "Waiting on you" row: who/what, the status in a word, since when, and the way in. */
function WaitingRow({
  entry,
  organizationSlug,
  projectName,
}: {
  entry: WaitingEntry;
  organizationSlug: string;
  projectName: string;
}) {
  const t = useT();
  const locale = useActiveLocale();
  const isApproval = entry.kind === 'approval';
  const title = isApproval ? t('MyDayScreen.deliverableReview') : entry.title;
  const since = isApproval ? entry.requestedAt : entry.waitingSince;
  // REQ-11: Triage opens the request itself, not the general inbox the person then has to search.
  const href =
    entry.kind === 'approval'
      ? `/${organizationSlug}/projects/${entry.projectId}`
      : `/${organizationSlug}/work/requests/${entry.clientRequestId}`;
  return (
    <li>
      <span className={`tm-avatar${isApproval ? '' : ' tm-avatar--client'}`} aria-hidden="true">
        {isApproval ? '◆' : '◎'}
      </span>
      <span className="tm-home-rows__title">
        {title} <span className="tm-home-rows__project">· {projectName}</span>
      </span>
      <span className="tm-home-rows__status" data-tone={waitingTone(entry.reason)}>
        {t(waitingReasonLabelKey(entry.reason))}
      </span>
      <span className="tm-meta-mono tm-home-rows__when">
        {t('MyDayScreen.since')} {shortDay(since, locale)}
      </span>
      <Link href={href} className="tm-button tm-button--outline tm-button--compact">
        {isApproval ? t('MyDayScreen.review') : t('MyDayScreen.triage')}
        <span className="tm-visually-hidden">: {title}</span>
      </Link>
    </li>
  );
}

/**
 * Today's real meetings and focus blocks, as the day capsule's slots. Meetings come from the
 * calendar grid (this week, anchored today) and blocks from the caller's own focus blocks. A
 * meeting is "now" for 30 minutes after it starts (the grid carries no end); a block is "now"
 * between its start and end. Nothing is invented: no data, no slots.
 */
function useDayPulseItems(
  api: ApiClient,
  organizationSlug: string,
): { items: DayPulseItem[]; upNext: PhoneUpNext | undefined } {
  const today = useMemo(() => todayWindow(), []);

  const grid = useQuery({
    queryKey: ['calendar-grid', organizationSlug, 'week', today.anchor],
    queryFn: () => getCalendarGrid(api, organizationSlug, { range: 'week', anchor: today.anchor }),
  });

  const blocks = useQuery({
    queryKey: ['focus-blocks', organizationSlug, today.from, today.to],
    queryFn: () => listFocusBlocks(api, organizationSlug, today.from, today.to),
  });

  return useMemo(() => {
    const now = Date.now();
    const slots: {
      id: string;
      start: number;
      end: number;
      label: string;
      href: string;
      kind: PhoneUpNext['kind'];
    }[] = [];
    const days = Array.isArray(grid.data?.days) ? grid.data.days : [];
    for (const day of days) {
      for (const meeting of Array.isArray(day.meetings) ? day.meetings : []) {
        const start = Date.parse(meeting.startsAt);
        if (Number.isNaN(start) || start < today.fromMs || start >= today.toMs) continue;
        slots.push({
          id: `meeting-${meeting.id}`,
          start,
          end: start + 30 * 60_000,
          label: meeting.title,
          href: `/${organizationSlug}/calendar`,
          kind: 'meeting',
        });
      }
    }
    for (const block of Array.isArray(blocks.data) ? blocks.data : []) {
      const start = Date.parse(block.startsAt);
      const end = Date.parse(block.endsAt);
      if (Number.isNaN(start) || start < today.fromMs || start >= today.toMs) continue;
      slots.push({
        id: `focus-${block.id}`,
        start,
        end: Number.isNaN(end) ? start : end,
        label: block.title,
        href: `/${organizationSlug}/calendar`,
        kind: 'focus',
      });
    }
    slots.sort((a, b) => a.start - b.start);
    let nextSeen = false;
    const live = slots.find((slot) => slot.end > now);
    const upNext: PhoneUpNext | undefined = live
      ? { label: live.label, start: live.start, end: live.end, href: live.href, kind: live.kind }
      : undefined;
    const items = slots.map((slot): DayPulseItem => {
      let state: DayPulseItem['state'];
      if (slot.end <= now) state = 'done';
      else if (slot.start <= now) state = 'now';
      else if (!nextSeen) {
        state = 'next';
        nextSeen = true;
      } else state = 'later';
      return {
        id: slot.id,
        time: new Date(slot.start).toLocaleTimeString(withNumerals('en-GB'), {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }),
        label: slot.label,
        state,
        href: slot.href,
      };
    });
    return { items, upNext };
  }, [grid.data, blocks.data, organizationSlug, today]);
}

function todayWindow() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    anchor: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    from: start.toISOString(),
    to: end.toISOString(),
    fromMs: start.getTime(),
    toMs: end.getTime(),
  };
}

function groupByProject(items: readonly MyDayEntry[]) {
  const order: string[] = [];
  const byProject = new Map<string, MyDayEntry[]>();
  for (const entry of items) {
    const id = entry.workItem.projectId;
    const list = byProject.get(id);
    if (list) list.push(entry);
    else {
      byProject.set(id, [entry]);
      order.push(id);
    }
  }
  return order.map((projectId) => ({ projectId, entries: byProject.get(projectId) ?? [] }));
}

type Translate = (key: MessageKey) => string;

function isArabic(locale: string): boolean {
  return locale.toLowerCase().startsWith('ar');
}

/** The sentence under the headline, from the API's derived counts, in the reader's language. */
function describeDay(
  summary: HomeSummary | undefined,
  unknown: boolean,
  t: Translate,
  locale: string,
): string {
  const lead = dayLead(summary, unknown, t, locale);
  if (unknown || !summary) return lead;
  const total = summary.personalWork.total + summary.waiting.total;
  if (total === 0) return lead;
  const count = (value: number) => String(value);
  const parts: string[] = [];
  if (summary.personalWork.overdue > 0) {
    parts.push(
      fill(t('MyDayScreen.dayPartOverdue'), { count: count(summary.personalWork.overdue) }),
    );
  }
  if (summary.personalWork.dueSoon > 0) {
    parts.push(
      fill(t('MyDayScreen.dayPartDueSoon'), { count: count(summary.personalWork.dueSoon) }),
    );
  }
  if (summary.waiting.total > 0) {
    parts.push(fill(t('MyDayScreen.dayPartWaiting'), { count: count(summary.waiting.total) }));
  }
  return parts.length > 0
    ? `${lead} ${capitalise(parts.join(t('MyDayScreen.listSeparator')))}.`
    : lead;
}

/** "Four things need you today." — the lead sentence alone, which the phone hero shows big. */
function dayLead(
  summary: HomeSummary | undefined,
  unknown: boolean,
  t: Translate,
  locale: string,
): string {
  if (unknown || !summary) return t('MyDayScreen.dayUnknown');
  const total = summary.personalWork.total + summary.waiting.total;
  if (total === 0) return t('MyDayScreen.dayClear');
  const category = new Intl.PluralRules(isArabic(locale) ? 'ar' : 'en').select(total);
  return fill(t(`MyDayScreen.dayLead.${category}` as MessageKey), {
    // English spells one to nine ("Two things need you today."), as the design writes it.
    count: isArabic(locale) ? String(total) : spell(total),
  });
}

function spell(value: number): string {
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  return words[value] ?? String(value);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Why now" — the ranking reason in words, with the date when there is one. */
function whyNow(entry: MyDayEntry, t: Translate, locale: string): string {
  const date = entry.workItem.dueAt ? shortDay(entry.workItem.dueAt, locale) : null;
  switch (entry.reason) {
    case 'overdue':
      return date ? fill(t('MyDayScreen.whyOverdueDue'), { date }) : t('MyDayScreen.whyOverdue');
    case 'due_soon':
      return date ? fill(t('MyDayScreen.whyDueSoonDue'), { date }) : t('MyDayScreen.whyDueSoon');
    case 'assigned':
      return date ? fill(t('MyDayScreen.whyAssignedDue'), { date }) : t('MyDayScreen.whyAssigned');
  }
}

/** "18 Aug" — the design's short day; the full instant stays one click away on the item. */
function shortDay(value: string | null, locale: string): string {
  if (value === null) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return formatDay(value);
  return parsed.toLocaleDateString(withNumerals(isArabic(locale) ? 'ar-u-nu-latn' : 'en-GB'), {
    day: 'numeric',
    month: 'short',
  });
}

/** "Thu 29 Oct" — the phone card's due day, with the weekday the design shows. */
function longDay(value: string, locale: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return formatDay(value);
  return parsed.toLocaleDateString(withNumerals(isArabic(locale) ? 'ar-u-nu-latn' : 'en-GB'), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function typeCode(type: string): string {
  switch (type) {
    case 'task':
      return 'TSK';
    case 'deliverable':
      return 'DEL';
    case 'doc':
    case 'document':
      return 'DOC';
    case 'bug':
      return 'BUG';
    case 'milestone':
      return 'MLS';
    default:
      return type.slice(0, 3).toUpperCase();
  }
}

function typeWord(type: string): string {
  return type.length > 0 ? type.charAt(0).toUpperCase() + type.slice(1) : 'Work';
}

function typeGlyph(type: string): string {
  switch (type) {
    case 'deliverable':
      return '◆';
    case 'doc':
    case 'document':
      return '◫';
    case 'milestone':
      return '◉';
    default:
      return '▤';
  }
}

function savedGlyph(entityType: SavedContextEntityType): string {
  switch (entityType) {
    case 'message':
      return '◌';
    case 'doc':
      return '◫';
    case 'work':
      return '▤';
    case 'file':
      return '⇪';
  }
}

/** The message key for the word each pinned reference shows. */
/** The short kind word in the saved meta line ("Work", "عمل") — never the raw entity key. */
function savedKindWord(entityType: SavedContextEntityType): string {
  switch (entityType) {
    case 'message':
      return translateOr('MyDayScreen.kindMessage', 'Message');
    case 'doc':
      return translateOr('HomeRecentItemsView.kindDocument', 'Doc');
    case 'work':
      return translateOr('HomeRecentItemsView.kindWork', 'Work');
    case 'file':
      return translateOr('MyDayScreen.kindFile', 'File');
  }
}

function savedTypeLabelKey(entityType: SavedContextEntityType): MessageKey {
  switch (entityType) {
    case 'message':
      return 'MyDayScreen.savedMessage';
    case 'doc':
      return 'MyDayScreen.savedDocument';
    case 'work':
      return 'MyDayScreen.savedWorkItem';
    case 'file':
      return 'MyDayScreen.savedFile';
  }
}

/** The saved column’s failure lines — catalog keys, so Arabic never shows English. */
const SAVED_ERROR_LINES: ApiErrorLines = {
  network: ['MyDayScreen.savedNetworkError', 'The network dropped before your saved items loaded.'],
  generic: ['MyDayScreen.savedGenericError', 'Something went wrong loading your saved items.'],
};

/** The message key for the word each ranking reason shows — the capsule is never colour alone. */
function reasonLabelKey(reason: MyDayReason): MessageKey {
  switch (reason) {
    case 'overdue':
      return 'MyDayScreen.overdue';
    case 'due_soon':
      return 'MyDayScreen.dueSoon';
    case 'assigned':
      return 'MyDayScreen.reasonAssigned';
  }
}

/** The work lists’ failure lines. */
const WORK_ERROR_LINES: ApiErrorLines = {
  network: ['MyDayScreen.workNetworkError', 'The network dropped before your work loaded.'],
  generic: ['MyDayScreen.workGenericError', 'Something went wrong loading your work.'],
};

/** The message key for the word each waiting reason shows — the status is never colour alone. */
function waitingReasonLabelKey(reason: WaitingReason): MessageKey {
  switch (reason) {
    case 'approval_requested':
      return 'MyDayScreen.waitingReviewRequested';
    case 'approval_viewed':
      return 'MyDayScreen.waitingInReview';
    case 'client_submitted':
      return 'MyDayScreen.waitingNewRequest';
    case 'client_triage':
      return 'MyDayScreen.waitingInTriage';
    case 'stale_follow_up':
      return 'MyDayScreen.waitingFollowUp';
  }
}

function waitingTone(reason: WaitingReason): 'warning' | 'danger' | 'neutral' {
  switch (reason) {
    case 'approval_requested':
    case 'client_submitted':
      return 'warning';
    case 'stale_follow_up':
      return 'danger';
    case 'approval_viewed':
    case 'client_triage':
      return 'neutral';
  }
}

/** "Waiting on you" failure lines. */
const WAITING_ERROR_LINES: ApiErrorLines = {
  network: ['MyDayScreen.waitingNetworkError', 'The network dropped before your reviews loaded.'],
  generic: [
    'MyDayScreen.waitingGenericError',
    'Something went wrong loading what is waiting on you.',
  ],
};

/** The summary’s failure lines. */
const SUMMARY_ERROR_LINES: ApiErrorLines = {
  network: ['MyDayScreen.summaryNetworkError', 'The network dropped before your summary loaded.'],
  generic: ['MyDayScreen.summaryGenericError', 'Something went wrong loading your summary.'],
};

/**
 * FIX3 item 10 (live check a6f66e47): the day capsule as a section's top bar, so a main section
 * other than My Day (Docs) carries the same schedule bar, from the same real data.
 */
export function DayScheduleBar({
  organizationSlug,
  client,
}: {
  readonly organizationSlug: string;
  readonly client?: ApiClient;
}) {
  const t = useT();
  const api = client ?? browserApiClient();
  const { items } = useDayPulseItems(api, organizationSlug);
  return (
    <DayPulseBar
      organizationSlug={organizationSlug}
      items={items}
      nowLabel={t('MyDayScreen.nothingScheduled')}
    />
  );
}
