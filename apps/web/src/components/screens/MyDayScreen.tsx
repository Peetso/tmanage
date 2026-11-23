'use client';

import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell, DayPulseBar } from '../shell/AppShell';
import type { DayPulseItem } from '../shell/AppShell';
import { FeatureOn } from '../shell/FeatureOn';
import { useShellCapability } from '../shell/use-shell-capability';
import { SupportLauncher } from '../support/SupportLauncher';
import { AiPanelLauncher } from '../ai-panel/AiPanelLauncher';
import { RunningTimerPill } from '../time/TimerControls';
import { timerKey } from '../time/use-running-timer';
import { HomeBriefingCard } from './HomeBriefingCard';
import { HomeHeroSection } from './HomeHeroSection';
import { HomePinnedSection } from './HomePinnedSection';
import { HomeRecentItemsView } from './HomeRecentItemsView';
import { PhoneHomeHero, PhoneHomeMetrics } from '../phone/PhoneHomeHero';
import type { PhoneUpNext } from '../phone/PhoneHomeHero';
import { PhoneIcon } from '../icons/phone';
import { ContextLens } from '../my-day/ContextLens';
import { GettingStartedRows } from '../my-day/GettingStartedRows';
import { RowMenu } from '../my-day/RowMenu';
import type { RowMenuItem } from '../my-day/RowMenu';
import { AutoTrackerHost, TimerRows } from '../my-day/TimerRows';
import { foldLayout } from '../my-day/my-day-layout';
import { deriveCounts, dueGroup, pickNext, splitWaiting, waitingId } from '../my-day/my-day-model';
import type { MyDayCounts } from '../my-day/my-day-model';
import { dragPath } from './WorkBoardView';
import { browserApiClient } from '../../lib/api/browser-client';
import { getHomeSummary, getMyDay, getSavedContext, getWaiting } from '../../lib/api/home';
import type {
  MyDay,
  MyDayReason,
  SavedContextEntityType,
  Waiting,
  WaitingReason,
} from '../../lib/api/home';
import { getHomeWidgetPrefs, updateHomeWidgetPrefs } from '../../lib/api/home-widget-prefs';
import type { HomeWidgetId } from '../../lib/api/home-widget-prefs';
import { listProjects } from '../../lib/api/projects';
import { transitionWorkItem } from '../../lib/api/work-items';
import { startTimer } from '../../lib/api/time-timer';
import { useTodaySlots } from '../../lib/use-today-slots';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiErrorLines } from '../../lib/api/describe-error';
import { formatDay, stateCapsule, stateLabel } from '../../lib/work-item-presentation';
import { typeCode, typeName } from '../../lib/work-item-type';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { translateOr } from '../../lib/i18n/compact-time';
import { withNumerals } from '../../lib/i18n/display-format';
import { appDateLocale } from '../../lib/i18n/app-locale';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { countNoun } from '../../lib/i18n/plural';
import { fill } from '../../lib/privacy-presentation';
import { MY_WORK_TOPIC, useWorkLiveRefresh } from '../../lib/use-work-live-refresh';
import type { MessageKey } from '../../lib/i18n/t';
import '../../styles/screens/home.css';
import { CoachMarkTour } from '../help/CoachMarkTour';
import { TeachingEmptyState } from '../help/TeachingEmptyState';
import { useTOr } from '../../lib/i18n/use-t-or';
import { usePendingWrites } from '../../lib/offline/use-offline';
import { ApproveSheet, LogTimeSheet, type ApprovalVerdict } from './MyDayPhoneSheets';
import { PricingSurveyCard } from './PricingSurveyCard';

export interface MyDayScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Test and story seam: a fixed clock, so "today" and the timer's day hold still. */
  now?: number;
}

type MyDayEntry = MyDay['items'][number];
type WaitingEntry = Waiting['items'][number];
type CardFilter = 'all' | 'overdue' | 'due_soon';

/** A Waiting list shows this many rows; "All (n)" opens the rest (spec MYDAY-V4 §4.3 Busy). */
const LIST_ROWS = 3;

/** The sheet open over My Day, if any (Figma 713:38899 Approve, 713:39060 Log time). */
type Sheet =
  | {
      readonly kind: 'approve';
      readonly approvalId: string;
      readonly version: number;
      readonly subject: string;
      readonly intent: ApprovalVerdict;
    }
  | {
      readonly kind: 'time';
      readonly workItemId: string;
      readonly workTitle: string;
      readonly projectName: string;
    };

/**
 * Where each part sits on the phone: one column in the rank order of spec MYDAY-V4 §4.4 (the
 * day bar and the title come first, from the shell). `styles/phone/home.css` turns these into
 * `order`; on the desktop the two columns keep the person's own order.
 */
const PHONE_RANK = {
  hero: 20,
  next: 30,
  gettingStartedNew: 35,
  myDay: 40,
  waitingOnYou: 50,
  metrics: 60,
  waitingOnOthers: 70,
  timer: 80,
  businessBriefing: 90,
  byProject: 100,
  savedContext: 110,
  pins: 120,
  recent: 130,
  gettingStarted: 140,
  quickQuestion: 150,
  edit: 160,
} as const;

/**
 * The approval version the reviewer read, when `/home/waiting` carries it. The decision route
 * needs it (optimistic concurrency); until the row has it, the row keeps the Review link.
 */
function waitingVersion(entry: WaitingEntry): number | undefined {
  const version = (entry as { readonly version?: unknown }).version;
  return typeof version === 'number' && Number.isSafeInteger(version) && version > 0
    ? version
    : undefined;
}

/** The clock the page reads: fixed in a story or test, else the minute, refreshed every 30 s. */
function usePageClock(fixed: number | undefined): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [fixed]);
  return fixed ?? now;
}

/**
 * **HOME-01 My Day, v4** (spec `MYDAY-V4-MERGE-SPEC`, Figma section `888:90133`, design review
 * `MYDAY-V4-FABLE-REVIEW`). The old design (Figma `351:1972`, this screen before `a50ecf32`),
 * kept as it was, with its parts placed by priority (spec §3.2):
 *
 * - Top: the black day capsule with Help, AI and Search as orbs at its end; the 64px "MY DAY"
 *   headline with New work, New project and the running-timer pill; the three numbers.
 * - Main column: "Do this next" first (nothing ever stands between the header and it), then
 *   Due & at risk, Waiting on you, Waiting on others, the business briefing, personal work by
 *   project, and Edit widgets at the end.
 * - Side column: the context lens beside "Do this next", then Timer, Saved, Pinned, Recently
 *   viewed, Getting started and the pricing question.
 *
 * ## A faithful reader
 *
 * Every number, title and row comes from the API. One ranked read (`my-day-model.ts`) feeds the
 * day sentence, the three numbers, "7 items", the chips and "Do this next", so they never
 * disagree (C4). Where the design shows data the API does not have (meeting attendees, who can
 * see a project as faces, a nudge that sends by itself) the screen draws what it does know.
 */
export function MyDayScreen({
  organizationSlug,
  organizationName,
  client,
  now: fixedNow,
}: MyDayScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const now = usePageClock(fixedNow);
  const may = useShellCapability(organizationSlug, client);
  const describeWaitingError = useDescribeApiError(WAITING_ERROR_LINES);
  const describeSavedError = useDescribeApiError(SAVED_ERROR_LINES);
  const describeSummaryError = useDescribeApiError(SUMMARY_ERROR_LINES);
  const [filter, setFilter] = useState<CardFilter>('all');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [picked, setPicked] = useState<MyDayEntry | null>(null);
  const [lensClosed, setLensClosed] = useState(false);
  const [touring, setTouring] = useState(false);
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());
  const [hiddenNow, setHiddenNow] = useState<ReadonlySet<HomeWidgetId>>(new Set());

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
  // The person's own order and hidden parts (Edit widgets, `home_widget_prefs`).
  const prefs = useQuery({
    queryKey: ['home-widget-prefs', organizationSlug],
    queryFn: () => getHomeWidgetPrefs(api, organizationSlug),
    retry: false,
  });
  const today = useTodaySlots(api, organizationSlug, fixedNow);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);
  const projectName = (id: string): string =>
    projectNames.get(id) ?? t('MyDayScreen.anotherProjectCap');

  // ── The one ranked read (C4) ──────────────────────────────────────────────────────────
  const items = useMemo(() => myDay.data?.items ?? [], [myDay.data]);
  const split = useMemo(() => splitWaiting(waiting.data?.items ?? []), [waiting.data]);
  const pick = pickNext(items, split.onYou);
  const counts = deriveCounts({
    summary: summary.data,
    items,
    waiting: split,
    waitingLoaded: waiting.isSuccess,
    meetings: today.meetingCount,
    now,
  });
  const countsKnown = myDay.isSuccess && (waiting.isSuccess || summary.isSuccess);
  const savedGroups = saved.data?.groups ?? [];
  const cards = items
    .filter((entry) => filter === 'all' || cardFilterOf(entry, now) === filter)
    .slice(0, 3);
  const groups = useMemo(() => groupByProject(items), [items]);
  const newMember = pick === null && projects.isSuccess && projects.data.length === 0;

  // ── Layout (Edit widgets): the person's order inside each column, and what is hidden ────
  const layout = foldLayout(prefs.data);
  const shown = (id: HomeWidgetId) => !layout.hidden.has(id) && !hiddenNow.has(id);
  const hide = (id: HomeWidgetId) => {
    setHiddenNow((current) => new Set(current).add(id));
    void updateHomeWidgetPrefs(api, organizationSlug, {
      order: [...layout.groups.top, ...layout.groups.main, ...layout.groups.side],
      hidden: [...new Set(layout.hidden).add(id)],
    })
      .then((view) => queryClient.setQueryData(['home-widget-prefs', organizationSlug], view))
      .catch(() => undefined);
  };

  // ── The context lens: the story of "Do this next", or of the card the person picked ─────
  const nextEntry = pick?.kind === 'work' ? pick.entry : null;
  const lensEntry = picked ?? (lensClosed ? null : (nextEntry ?? items[0] ?? null));
  const pickEntry = (entry: MyDayEntry) => {
    setPicked(entry);
    setLensClosed(false);
  };

  // ── Row actions ───────────────────────────────────────────────────────────────────────
  const complete = async (entry: MyDayEntry) => {
    const item = entry.workItem;
    const path = dragPath(item.state, 'done', item.ownerUserId !== null);
    // No path the person may take from here (a blocker to clear first): the item page asks.
    if (path === null || path.length === 0) {
      window.location.assign(`/${organizationSlug}/work/${encodeURIComponent(item.id)}`);
      return;
    }
    setCompleting((current) => new Set(current).add(item.id));
    try {
      let current = item;
      for (const to of path) {
        current = await transitionWorkItem(api, organizationSlug, item.id, {
          version: current.version,
          to,
          facts:
            to === 'done' && current.ownerUserId !== null
              ? { ownerId: current.ownerUserId, completedAt: new Date().toISOString() }
              : {},
        });
      }
    } catch {
      window.location.assign(`/${organizationSlug}/work/${encodeURIComponent(item.id)}`);
    } finally {
      setCompleting((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
      await queryClient.invalidateQueries({ queryKey: ['home'] });
    }
  };

  const startOn = async (entry: MyDayEntry) => {
    try {
      await startTimer(api, organizationSlug, { workItemId: entry.workItem.id });
      await queryClient.invalidateQueries({ queryKey: timerKey(organizationSlug) });
    } catch {
      // Another timer runs: the item page asks whether to switch (52-01).
      window.location.assign(`/${organizationSlug}/work/${encodeURIComponent(entry.workItem.id)}`);
    }
  };

  const logTime = (entry: MyDayEntry) =>
    setSheet({
      kind: 'time',
      workItemId: entry.workItem.id,
      workTitle: entry.workItem.title,
      projectName: projectName(entry.workItem.projectId),
    });

  const workMenu = (entry: MyDayEntry): RowMenuItem[] => [
    { id: 'story', label: t('MyDay.taskStory'), onSelect: () => pickEntry(entry) },
    {
      id: 'complete',
      label: fill(t('MyDay.complete'), { title: entry.workItem.title }),
      onSelect: () => {
        if (!completing.has(entry.workItem.id)) void complete(entry);
      },
    },
    {
      id: 'reschedule',
      label: t('MyDay.reschedule'),
      href: `/${organizationSlug}/work/${encodeURIComponent(entry.workItem.id)}`,
    },
    { id: 'log', label: t('MyDay.logTime'), onSelect: () => logTime(entry) },
    { id: 'timer', label: t('MyDay.startTimer'), onSelect: () => void startOn(entry) },
  ];

  const decide = (entry: WaitingEntry, intent: ApprovalVerdict, subject: string) => {
    if (entry.kind !== 'approval') return;
    const version = waitingVersion(entry);
    if (version === undefined) return;
    setSheet({ kind: 'approve', approvalId: entry.approvalId, version, subject, intent });
  };

  const timedTitle = (workItemId: string): string | null =>
    items.find((entry) => entry.workItem.id === workItemId)?.workItem.title ?? null;

  const headline = !countsKnown
    ? t('MyDayScreen.dayUnknown')
    : counts.open + counts.waitingOnYou === 0
      ? tOr('PhoneHome.dayClear', 'Nothing needs you right now.')
      : dayLead(counts, t, locale);

  // ── The parts, each in its own place ──────────────────────────────────────────────────
  const part = (rank: number, id: string, node: ReactNode): ReactNode => (
    <div key={id} className="tm-home-part" data-rank={rank} data-widget={id}>
      {node}
    </div>
  );

  const dueSection = (
    <section className="tm-home-section" aria-labelledby="tm-my-day-personal">
      <div className="tm-section-head">
        <h2 id="tm-my-day-personal" className="tm-section-head__title">
          {t('MyDayScreen.dueAtRisk')}
        </h2>
        <span className="tm-section-head__meta tm-home-section__count">
          {counts.open}{' '}
          {countNoun(locale, counts.open, t('MyDayScreen.item'), t('MyDayScreen.items'))}
        </span>
        <span className="tm-phone-home__count" aria-hidden="true">
          {counts.open}
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
            {t('MyDayScreen.overdue')} · {counts.overdue}
          </button>
          <button
            type="button"
            className="tm-chip tm-chip--compact"
            aria-pressed={filter === 'due_soon'}
            onClick={() => setFilter('due_soon')}
          >
            {t('MyDayScreen.dueSoon')} · {counts.today + counts.soon}
          </button>
        </div>
      </div>

      {myDay.isError ? (
        <InlineAlert tone="danger" live>
          {t('MyDayScreen.workError')}
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
                inLens={lensEntry?.workItem.id === entry.workItem.id}
                organizationSlug={organizationSlug}
                projectName={projectName(entry.workItem.projectId)}
                menu={workMenu(entry)}
                onPick={() => pickEntry(entry)}
                onLogTime={() => logTime(entry)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );

  const waitingOnYouSection = (
    <WaitingList
      id="tm-my-day-waiting"
      title={t('MyDayScreen.waitingOnYou')}
      meta={t('MyDayScreen.waitingMeta')}
      entries={split.onYou}
      pending={waiting.isPending}
      error={waiting.isError ? describeWaitingError(waiting.error) : null}
      emptyTitle={t('MyDayScreen.nothingWaitingTitle')}
      emptyBody={t('MyDayScreen.nothingWaitingBody')}
      organizationSlug={organizationSlug}
      projectName={projectName}
      onDecide={decide}
    />
  );

  const waitingOnOthersSection = (
    <WaitingList
      id="tm-my-day-waiting-others"
      title={t('MyDayScreen.waitingOnOthers')}
      meta={t('MyDayScreen.waitingOthersMeta')}
      entries={split.onOthers}
      pending={waiting.isPending}
      // One read feeds both lists: its failure is worded once, under Waiting on you.
      error={null}
      failed={waiting.isError}
      emptyTitle={t('MyDay.nothingWaiting')}
      emptyBody={null}
      organizationSlug={organizationSlug}
      projectName={projectName}
      onDecide={decide}
    />
  );

  const byProjectSection =
    groups.length > 0 ? (
      <section className="tm-home-section tm-home-section--quiet" aria-labelledby="tm-my-day-all">
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
                <bdi>{projectName(group.projectId)}</bdi>
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
                    <span className="tm-meta-mono tm-home-group__due" data-reason={entry.reason}>
                      {shortDay(entry.workItem.dueAt, locale)}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  const savedSection = (
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
          <h3 className="tm-home-saved__group">
            <bdi>{projectName(group.projectId)}</bdi>
          </h3>
          <ul
            className="tm-home-saved__list"
            aria-label={`${t('MyDayScreen.savedInPrefix')} ${projectNames.get(group.projectId) ?? t('MyDayScreen.anotherProject')}`}
          >
            {group.items.map((item) => {
              // d69bc30e: the saved thing's own name, read through its own gate; `null` when the
              // viewer may not see it, which keeps the kind word.
              const name = savedTitle(item) ?? t(savedTypeLabelKey(item.entityType));
              return (
                <li key={item.id} className="tm-home-saved__item" data-kind={item.entityType}>
                  <span className="tm-home-orb" aria-hidden="true">
                    {savedGlyph(item.entityType)}
                  </span>
                  <span className="tm-home-saved__text">
                    <span className="tm-home-saved__title">
                      {item.entityType === 'work' ? (
                        <Link href={`/${organizationSlug}/work/${item.entityId}`}>
                          <bdi>{name}</bdi>
                        </Link>
                      ) : (
                        <bdi>{name}</bdi>
                      )}
                    </span>
                    <span className="tm-home-saved__meta">
                      {savedKindWord(item.entityType)} · {t('MyDayScreen.savedCountSuffix')}{' '}
                      {shortDay(item.createdAt, locale)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );

  const mainPart = (id: HomeWidgetId): ReactNode => {
    if (!shown(id)) return null;
    switch (id) {
      case 'myDay':
        return part(PHONE_RANK.myDay, id, dueSection);
      case 'waiting':
        return [
          part(PHONE_RANK.waitingOnYou, 'waitingOnYou', waitingOnYouSection),
          part(PHONE_RANK.waitingOnOthers, 'waitingOnOthers', waitingOnOthersSection),
        ];
      case 'businessBriefing':
        return part(
          PHONE_RANK.businessBriefing,
          id,
          <HomeBriefingCard organizationSlug={organizationSlug} client={client} />,
        );
      case 'byProject':
        return part(PHONE_RANK.byProject, id, byProjectSection);
      default:
        return null;
    }
  };

  const sidePart = (id: HomeWidgetId): ReactNode => {
    if (!shown(id)) return null;
    switch (id) {
      case 'timer':
        return part(
          PHONE_RANK.timer,
          id,
          <FeatureOn organizationSlug={organizationSlug} flag="time_tracking">
            <TimerRows
              api={api}
              slug={organizationSlug}
              now={now}
              startOn={nextEntry?.workItem.id ?? null}
              timedTitle={timedTitle}
            />
          </FeatureOn>,
        );
      case 'savedContext':
        return part(PHONE_RANK.savedContext, id, savedSection);
      case 'pins':
        return part(
          PHONE_RANK.pins,
          id,
          <HomePinnedSection organizationSlug={organizationSlug} client={client} />,
        );
      case 'recent':
        return part(
          PHONE_RANK.recent,
          id,
          <HomeRecentItemsView organizationSlug={organizationSlug} client={client} />,
        );
      case 'gettingStarted':
        return part(
          newMember ? PHONE_RANK.gettingStartedNew : PHONE_RANK.gettingStarted,
          id,
          <GettingStartedRows
            api={api}
            slug={organizationSlug}
            onHide={() => hide('gettingStarted')}
            onTour={() => setTouring(true)}
          />,
        );
      case 'quickQuestion':
        return part(
          PHONE_RANK.quickQuestion,
          id,
          <PricingSurveyCard api={api} organizationSlug={organizationSlug} />,
        );
      default:
        return null;
    }
  };

  // A new member has nothing to tell a story about, so Getting started takes the top of the side
  // column: for this person it is rank 2 (spec §4.3).
  const sideOrder: readonly HomeWidgetId[] = newMember
    ? ['gettingStarted', ...layout.groups.side.filter((id) => id !== 'gettingStarted')]
    : layout.groups.side;

  const pulseItems: DayPulseItem[] = today.slots.map((slot) => ({
    id: slot.id,
    time: new Date(slot.start).toLocaleTimeString(withNumerals('en-GB'), {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }),
    label: slot.label,
    state: slot.state,
    href: slot.href,
  }));
  const live = today.slots.find((slot) => slot.end > now);
  const upNext: PhoneUpNext | undefined = live
    ? { label: live.label, start: live.start, end: live.end, href: live.href, kind: live.kind }
    : undefined;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="home"
      title={t('MyDayScreen.title')}
      titleVariant="display"
      actionsPlacement="inline"
      header="page"
      actions={
        <>
          <Link
            href={`/${organizationSlug}/capture`}
            className="tm-button tm-button--ink tm-button--feature"
          >
            <span className="tm-button__orb" aria-hidden="true">
              +
            </span>
            {t('MyDayScreen.newWork')}
          </Link>
          {may('project.create') ? (
            <Link
              href={`/${organizationSlug}/projects/new`}
              className="tm-button tm-button--ink tm-button--compact tm-home-new-project"
            >
              {tOr('CommandPaletteV2.newProject', 'New project')}
            </Link>
          ) : null}
          <FeatureOn organizationSlug={organizationSlug} flag="time_tracking">
            <RunningTimerPill
              organizationSlug={organizationSlug}
              variant="capsule"
              {...(client ? { client } : {})}
            />
            <AutoTrackerHost api={api} slug={organizationSlug} />
          </FeatureOn>
        </>
      }
      description={describeDay(counts, !countsKnown, t, locale)}
      headerAside={
        shown('summary') ? (
          <HomeHeroSection
            organizationSlug={organizationSlug}
            client={client}
            counts={
              countsKnown
                ? {
                    openWork: counts.open,
                    dueToday: counts.today,
                    waitingOnYou: counts.waitingOnYou,
                    meetingsToday: counts.meetings,
                  }
                : undefined
            }
            links={{
              openWork: '#tm-my-day-personal',
              waitingOnYou: '#tm-my-day-waiting',
              meetingsToday: `/${organizationSlug}/calendar`,
            }}
          />
        ) : undefined
      }
      topBar={
        <DayPulseBar
          organizationSlug={organizationSlug}
          items={pulseItems}
          nowLabel={pick ? nextTitle(pick, t) : t('MyDayScreen.nothingScheduled')}
          orbs={
            <>
              <SupportLauncher organizationSlug={organizationSlug} variant="orb" />
              <AiPanelLauncher organizationSlug={organizationSlug} variant="orb" />
            </>
          }
        />
      }
    >
      <div className="tm-home" data-new-member={newMember || undefined}>
        <div className="tm-home-body">
          <div className="tm-home-main">
            {/* Phone (<768px): the hero with the day's sentence, second under the day bar. */}
            <PhoneHomeHero headline={headline} />

            {/* Rank 1: nothing ever stands between the header and "Do this next" (spec §4.2). */}
            {part(
              PHONE_RANK.next,
              'next',
              <FocusCapsule
                pick={pick}
                pending={pick === null && (myDay.isPending || waiting.isPending)}
                newMember={newMember}
                organizationSlug={organizationSlug}
                projectName={projectName}
                onDecide={decide}
              />,
            )}

            {summary.isError ? (
              <InlineAlert tone="danger" title={t('MyDayScreen.summaryError')} live>
                {describeSummaryError(summary.error)}
              </InlineAlert>
            ) : null}

            {layout.groups.main.map(mainPart)}

            {/* Phone: the three numbers, one row of three, sixth (spec §4.4). */}
            <PhoneHomeMetrics
              api={api}
              organizationSlug={organizationSlug}
              approvalsWaiting={summary.data?.waiting.approvals}
              upNext={upNext}
            />

            {part(
              PHONE_RANK.edit,
              'edit',
              <Link
                href={`/${organizationSlug}/home/widgets`}
                className="tm-button tm-button--outline tm-button--compact tm-home-edit"
              >
                {t('MyDay.editWidgets')}
              </Link>,
            )}
          </div>

          <div className="tm-home-side">
            {lensEntry ? (
              <ContextLens
                api={api}
                slug={organizationSlug}
                entry={lensEntry}
                projectName={projectName(lensEntry.workItem.projectId)}
                picked={picked !== null}
                onClose={() => {
                  setPicked(null);
                  setLensClosed(true);
                }}
              />
            ) : null}
            {sideOrder.map(sidePart)}
          </div>
        </div>
      </div>

      {sheet?.kind === 'approve' ? (
        <ApproveSheet
          api={api}
          organizationSlug={organizationSlug}
          approvalId={sheet.approvalId}
          version={sheet.version}
          subject={sheet.subject}
          intent={sheet.intent}
          onClose={() => setSheet(null)}
          onDecided={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === 'time' ? (
        <LogTimeSheet
          api={api}
          organizationSlug={organizationSlug}
          workItemId={sheet.workItemId}
          workTitle={sheet.workTitle}
          projectName={sheet.projectName}
          onClose={() => setSheet(null)}
          onLogged={() => setSheet(null)}
        />
      ) : null}
      {/* The tour opens on the first visit as before; "Take the tour" opens it again (rank 19). */}
      {touring ? (
        <CoachMarkTour
          organizationSlug={organizationSlug}
          tour="my_day"
          onDemand={() => setTouring(false)}
          {...(client ? { client } : {})}
        />
      ) : (
        <CoachMarkTour
          organizationSlug={organizationSlug}
          tour="my_day"
          {...(client ? { client } : {})}
        />
      )}
    </AppShell>
  );
}

type NextPick = NonNullable<ReturnType<typeof pickNext>>;

/** The title of the item "Do this next" names. */
function nextTitle(pick: NextPick, t: Translate): string {
  if (pick.kind === 'work') return pick.entry.workItem.title;
  return pick.entry.kind === 'approval'
    ? approvalSubject(pick.entry, t('MyDayScreen.deliverableReview'))
    : pick.entry.title;
}

/**
 * **Do this next** — the black focus capsule (`351:2087`), the first content part, as wide as the
 * cards under it. Its end holds the state flag and the arrow orb; when the next thing is an
 * approval, "Approve" (the one lime action) and "Send back" take the orb's place (spec §4.3). A
 * new member reads "Create your first task" with the New work action; an empty day reads the
 * old clear line and has no action.
 */
function FocusCapsule({
  pick,
  pending,
  newMember,
  organizationSlug,
  projectName,
  onDecide,
}: {
  pick: ReturnType<typeof pickNext>;
  pending: boolean;
  newMember: boolean;
  organizationSlug: string;
  projectName: (id: string) => string;
  onDecide: (entry: WaitingEntry, intent: ApprovalVerdict, subject: string) => void;
}) {
  const t = useT();
  const locale = useActiveLocale();

  if (pending) {
    return (
      <LoadingRegion label={t('MyDayScreen.loadingWork')}>
        <Skeleton height="76px" radius="var(--r-capsule)" />
      </LoadingRegion>
    );
  }

  const capsule = (orb: boolean, title: ReactNode, why: string | null, end: ReactNode) => (
    <div
      className={`tm-focus-capsule tm-home-focus${orb ? '' : ' tm-focus-capsule--plain'}`}
      role="group"
      aria-label={t('MyDayScreen.doThisNext')}
    >
      {orb ? (
        <span className="tm-focus-capsule__orb" aria-hidden="true">
          <span className="tm-home-flip">▸</span>
        </span>
      ) : null}
      <div className="tm-focus-capsule__text">
        <p className="tm-focus-capsule__title">{title}</p>
        {why ? <p className="tm-focus-capsule__why">{why}</p> : null}
      </div>
      {end ? <div className="tm-focus-capsule__end">{end}</div> : null}
    </div>
  );

  if (pick === null) {
    if (newMember) {
      return capsule(
        true,
        t('MyDay.firstTask'),
        null,
        <Link
          href={`/${organizationSlug}/capture`}
          className="tm-button tm-button--lime tm-button--compact"
        >
          {t('MyDayScreen.newWork')}
        </Link>,
      );
    }
    return capsule(false, t('MyDay.nothingNeedsYou'), t('MyDayScreen.dayClear'), null);
  }

  if (pick.kind === 'work') {
    const top = pick.entry;
    const href = `/${organizationSlug}/work/${top.workItem.id}`;
    return capsule(
      true,
      <Link href={href}>{top.workItem.title}</Link>,
      fill(t('MyDayScreen.whyNow'), {
        reason: whyNow(top, t, locale),
        project: projectName(top.workItem.projectId),
      }),
      <>
        <span className="tm-home-focus__flag">
          <span className="tm-home-focus__flag-glyph" aria-hidden="true">
            !
          </span>
          {stateLabel(top.workItem.state)}
        </span>
        <Link
          href={href}
          className="tm-home-focus__go"
          aria-label={`${t('MyDayScreen.openPrefix')} ${top.workItem.title}`}
        >
          <span aria-hidden="true" className="tm-home-flip">
            →
          </span>
        </Link>
      </>,
    );
  }

  const entry = pick.entry;
  const title =
    entry.kind === 'approval'
      ? approvalSubject(entry, t('MyDayScreen.deliverableReview'))
      : entry.title;
  const href = waitingHref(organizationSlug, entry);
  const since = entry.kind === 'approval' ? entry.requestedAt : entry.waitingSince;
  const why = `${t(waitingReasonLabelKey(entry.reason))} · ${projectName(entry.projectId)} · ${t('MyDayScreen.since')} ${shortDay(since, locale)}`;
  const version = waitingVersion(entry);
  return capsule(
    true,
    <Link href={href}>{title}</Link>,
    why,
    entry.kind === 'approval' && version !== undefined ? (
      <>
        <button
          type="button"
          className="tm-button tm-button--outline tm-button--compact tm-home-focus__secondary"
          onClick={() => onDecide(entry, 'request_changes', title)}
        >
          {t('MyDay.sendBack')}
          <span className="tm-visually-hidden">: {title}</span>
        </button>
        <button
          type="button"
          className="tm-button tm-button--lime tm-button--compact"
          onClick={() => onDecide(entry, 'approve', title)}
        >
          {t('MyDay.approve')}
          <span className="tm-visually-hidden">: {title}</span>
        </button>
      </>
    ) : (
      <Link
        href={href}
        className="tm-home-focus__go"
        aria-label={`${t('MyDayScreen.openPrefix')} ${title}`}
      >
        <span aria-hidden="true" className="tm-home-flip">
          →
        </span>
      </Link>
    ),
  );
}

/** One "Due & at risk" card: the first is the lime one, the rest white (HOME-01). */
function WorkCard({
  entry,
  lime,
  inLens,
  organizationSlug,
  projectName,
  menu,
  onPick,
  onLogTime,
}: {
  entry: MyDayEntry;
  lime: boolean;
  inLens: boolean;
  organizationSlug: string;
  projectName: string;
  menu: readonly RowMenuItem[];
  onPick: () => void;
  onLogTime: () => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const href = `/${organizationSlug}/work/${entry.workItem.id}`;
  // Offline, a logged time waits in the queue: the card says so, with no button (review point 3).
  const pendingTime = usePendingWrites(organizationSlug, entry.workItem.id, 'time-log');
  // A press on the card (not on one of its controls) tells its story in the lens (spec §4.2).
  // The keyboard reaches the same through "⋯ › Task story".
  const onCardClick = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.target instanceof Element && event.target.closest('a, button, [role="menu"]')) {
      return;
    }
    onPick();
  };
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- a pointer shortcut; the menu's "Task story" is the keyboard path
    <article
      className={`tm-card tm-home-card${lime ? ' tm-card--lime' : ''}`}
      data-in-lens={inLens || undefined}
      onClick={onCardClick}
    >
      <div className="tm-home-card__top">
        <span className="tm-card__eyebrow">
          <span className="tm-home-orb" aria-hidden="true">
            {typeGlyph(entry.workItem.type)}
          </span>
          <span className="tm-home-card__eyebrow-text">
            <span>{typeName(entry.workItem.type)} ·</span> <bdi dir="auto">{projectName}</bdi>
          </span>
        </span>
        <span className="tm-home-card__orbs">
          <RowMenu label={fill(t('MyDay.rowMore'), { title: entry.workItem.title })} items={menu} />
          <span className="tm-home-orb" aria-hidden="true">
            <span className="tm-home-flip">↗</span>
          </span>
        </span>
      </div>
      <span className="tm-phone-home-card__orb" aria-hidden="true">
        <PhoneIcon name={entry.workItem.type === 'deliverable' ? 'image' : 'work'} />
      </span>
      <h3 className="tm-card__title">
        <Link href={href}>{entry.workItem.title}</Link>
      </h3>
      <span className="tm-phone-home-card__meta">
        <bdi>{projectName}</bdi> ·{' '}
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
      {pendingTime.length > 0 ? (
        <div className="tm-phone-card-status" role="status">
          <StateCapsule state="waiting">{tOr('PhoneHome.notSaved', 'Not saved')}</StateCapsule>
          <p>
            {tOr(
              'PhoneHome.keptOnPhone',
              'Kept on this phone. It is sent when you are back online.',
            )}
          </p>
        </div>
      ) : null}
      <div className="tm-phone-card-actions">
        <Button type="button" tone="outline" size="accessible" onClick={onLogTime}>
          {tOr('PhoneHome.logTime', 'Log time')}
          <span className="tm-visually-hidden">: {entry.workItem.title}</span>
        </Button>
      </div>
    </article>
  );
}

/** "Homepage concept · v2" — the deliverable and its version, else the generic label. */
function approvalSubject(
  entry: Extract<WaitingEntry, { kind: 'approval' }>,
  generic: string,
): string {
  if (entry.deliverableTitle === null) return generic;
  return entry.versionNo === null
    ? entry.deliverableTitle
    : `${entry.deliverableTitle} · v${entry.versionNo}`;
}

/** Where a waiting row opens: the project's approvals, or the client request itself (REQ-11). */
function waitingHref(organizationSlug: string, entry: WaitingEntry): string {
  return entry.kind === 'approval'
    ? `/${organizationSlug}/projects/${entry.projectId}`
    : `/${organizationSlug}/work/requests/${entry.clientRequestId}`;
}

/**
 * One Waiting list, on the old row list (`351:2156`): "Waiting on you" (Review, Triage) or
 * "Waiting on others" (Nudge, which opens the request thread: the API has no nudge of its own).
 * Three rows, then "All (n)" opens the rest in place.
 */
function WaitingList({
  id,
  title,
  meta,
  entries,
  pending,
  error,
  failed = false,
  emptyTitle,
  emptyBody,
  organizationSlug,
  projectName,
  onDecide,
}: {
  id: string;
  title: string;
  meta: string;
  entries: readonly WaitingEntry[];
  pending: boolean;
  /** The worded failure, drawn here; `null` draws none. */
  error: string | null;
  /** The read failed and another list words it: draw neither rows nor an empty card. */
  failed?: boolean;
  emptyTitle: string;
  emptyBody: string | null;
  organizationSlug: string;
  projectName: (id: string) => string;
  onDecide: (entry: WaitingEntry, intent: ApprovalVerdict, subject: string) => void;
}) {
  const t = useT();
  const [all, setAll] = useState(false);
  const rows = all ? entries : entries.slice(0, LIST_ROWS);
  return (
    <section className="tm-home-section tm-home-section--quiet" aria-labelledby={id}>
      <div className="tm-section-head">
        <h2 id={id} className="tm-section-head__title">
          {title}
        </h2>
        <span className="tm-section-head__meta">{meta}</span>
        {entries.length > LIST_ROWS ? (
          <button
            type="button"
            className="tm-section-head__end tm-chip tm-chip--compact"
            aria-expanded={all}
            onClick={() => setAll((value) => !value)}
          >
            {fill(t('MyDay.allCount'), { count: entries.length })}
          </button>
        ) : null}
      </div>

      {error !== null ? (
        <InlineAlert tone="danger" title={t('MyDayScreen.waitingError')} live>
          {error}
        </InlineAlert>
      ) : null}

      {pending ? (
        <LoadingRegion label={t('MyDayScreen.loadingWaiting')}>
          <Skeleton height="44px" />
          <Skeleton height="44px" />
        </LoadingRegion>
      ) : null}

      {!pending && error === null && !failed && entries.length === 0 ? (
        <div className="tm-card tm-card--empty tm-home-empty">
          <h3 className="tm-card__title">{emptyTitle}</h3>
          {emptyBody ? <p className="tm-card__meta">{emptyBody}</p> : null}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <ul className="tm-row-list tm-home-rows" aria-label={title}>
          {rows.map((entry) => (
            <WaitingRow
              key={waitingId(entry)}
              entry={entry}
              organizationSlug={organizationSlug}
              projectName={projectName(entry.projectId)}
              onDecide={onDecide}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** One waiting row: who/what, the status in a word, since when, "⋯", and the way in. */
function WaitingRow({
  entry,
  organizationSlug,
  projectName,
  onDecide,
}: {
  entry: WaitingEntry;
  organizationSlug: string;
  projectName: string;
  onDecide: (entry: WaitingEntry, intent: ApprovalVerdict, subject: string) => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const locale = useActiveLocale();
  const isApproval = entry.kind === 'approval';
  const onOthers = entry.reason === 'stale_follow_up';
  const version = waitingVersion(entry);
  // TESTUX P1 7: the row and the Approve sheet name the work ("Homepage concept · v2"), so two
  // waiting reviews never read the same; the generic label stays only when nothing is known.
  const title = isApproval
    ? approvalSubject(entry, t('MyDayScreen.deliverableReview'))
    : entry.title;
  const since = isApproval ? entry.requestedAt : entry.waitingSince;
  // REQ-11: Triage opens the request itself, not the general inbox the person then has to search.
  const href = waitingHref(organizationSlug, entry);
  const action = onOthers
    ? t('MyDay.nudge')
    : isApproval
      ? t('MyDayScreen.review')
      : t('MyDayScreen.triage');
  const menu: RowMenuItem[] = [{ id: 'open', label: t('MyDay.open'), href }];
  if (isApproval && version !== undefined) {
    menu.push(
      {
        id: 'approve',
        label: t('MyDay.approve'),
        onSelect: () => onDecide(entry, 'approve', title),
      },
      {
        id: 'send-back',
        label: t('MyDay.sendBack'),
        onSelect: () => onDecide(entry, 'request_changes', title),
      },
    );
  }
  return (
    <li>
      <span className={`tm-avatar${isApproval ? '' : ' tm-avatar--client'}`} aria-hidden="true">
        {isApproval ? '◆' : '◎'}
      </span>
      <span className="tm-home-rows__title">
        <bdi dir="auto">{title}</bdi>{' '}
        <span className="tm-home-rows__project">
          · <bdi dir="auto">{projectName}</bdi>
        </span>
      </span>
      <span className="tm-home-rows__status" data-tone={waitingTone(entry.reason)}>
        {t(waitingReasonLabelKey(entry.reason))}
      </span>
      <span className="tm-meta-mono tm-home-rows__when">
        {t('MyDayScreen.since')} {shortDay(since, locale)}
      </span>
      <RowMenu label={fill(t('MyDay.rowMore'), { title })} items={menu} />
      <Link href={href} className="tm-button tm-button--outline tm-button--compact">
        {action}
        <span className="tm-visually-hidden">: {title}</span>
      </Link>
      {isApproval && version !== undefined ? (
        <div className="tm-phone-card-actions">
          <Button
            type="button"
            tone="ink"
            size="accessible"
            onClick={() => onDecide(entry, 'approve', title)}
          >
            {tOr('PhoneHome.approve', 'Approve')}
            <span className="tm-visually-hidden">: {title}</span>
          </Button>
          <Button
            type="button"
            tone="outline"
            size="accessible"
            onClick={() => onDecide(entry, 'request_changes', title)}
          >
            {tOr('PhoneHome.sendBack', 'Send back')}
            <span className="tm-visually-hidden">: {title}</span>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** The chip an item answers to: Overdue, or Due soon (due today or in the days just ahead). */
function cardFilterOf(entry: MyDayEntry, now: number): CardFilter {
  const group = dueGroup(entry, now);
  if (group === 'overdue') return 'overdue';
  if (group === 'today' || group === 'soon') return 'due_soon';
  return 'all';
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

/**
 * The sentence under the headline, in the reader's language. Its numbers are the ranked read's
 * (C4): the same ones the three numbers, "7 items" and the chips show.
 */
function describeDay(counts: MyDayCounts, unknown: boolean, t: Translate, locale: string): string {
  if (unknown) return t('MyDayScreen.dayUnknown');
  const total = counts.open + counts.waitingOnYou;
  if (total === 0) return t('MyDayScreen.dayClear');
  const lead = dayLead(counts, t, locale);
  const parts: string[] = [];
  if (counts.overdue > 0) {
    parts.push(fill(t('MyDayScreen.dayPartOverdue'), { count: String(counts.overdue) }));
  }
  const dueSoon = counts.today + counts.soon;
  if (dueSoon > 0) {
    parts.push(fill(t('MyDayScreen.dayPartDueSoon'), { count: String(dueSoon) }));
  }
  if (counts.waitingOnYou > 0) {
    parts.push(fill(t('MyDayScreen.dayPartWaiting'), { count: String(counts.waitingOnYou) }));
  }
  return parts.length > 0
    ? `${lead} ${capitalise(parts.join(t('MyDayScreen.listSeparator')))}.`
    : lead;
}

/** "Four things need you today." — the lead sentence alone, which the phone hero shows big. */
function dayLead(counts: MyDayCounts, t: Translate, locale: string): string {
  const total = counts.open + counts.waitingOnYou;
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
  return parsed.toLocaleDateString(appDateLocale(locale), {
    day: 'numeric',
    month: 'short',
  });
}

/** "Thu 29 Oct" — the phone card's due day, with the weekday the design shows. */
function longDay(value: string, locale: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return formatDay(value);
  return parsed.toLocaleDateString(appDateLocale(locale), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
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

/** The saved thing's own name (d69bc30e), when the API resolved one the viewer may see. */
function savedTitle(item: { readonly title?: string | null }): string | null {
  return typeof item.title === 'string' && item.title.trim() !== '' ? item.title : null;
}

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
