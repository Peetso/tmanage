'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InfoButton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { NavIcon } from '../icons/phone';
import { CoachMarkTour } from '../help/CoachMarkTour';
import { dragPath } from './WorkBoardView';
import { ApproveSheet, LogTimeSheet } from './MyDayPhoneSheets';
import type { ApprovalVerdict } from './MyDayPhoneSheets';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { getHomeSummary, getMyDay, getWaiting } from '../../lib/api/home';
import { getHomeWidgetPrefs, updateHomeWidgetPrefs } from '../../lib/api/home-widget-prefs';
import type { HomeWidgetId } from '../../lib/api/home-widget-prefs';
import { listProjects } from '../../lib/api/projects';
import { transitionWorkItem } from '../../lib/api/work-items';
import { startTimer } from '../../lib/api/time-timer';
import { timerKey } from '../time/use-running-timer';
import { useTodaySlots } from '../../lib/use-today-slots';
import { useOnline } from '../../lib/offline/use-offline';
import { MY_WORK_TOPIC, useWorkLiveRefresh } from '../../lib/use-work-live-refresh';
import { fill } from '../../lib/privacy-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import type { WidgetState } from '../my-day/MyDayWidget';
import {
  ByProjectWidget,
  DueWidget,
  GlanceWidget,
  NextWidget,
  TodayWidget,
  WaitingWidget,
} from '../my-day/WorkWidgets';
import type { NextMode, WidgetContext } from '../my-day/WorkWidgets';
import {
  BriefingWidget,
  GettingStartedWidget,
  PinnedWidget,
  QuickQuestionWidget,
  RecentWidget,
  SavedWidget,
  TimerWidget,
} from '../my-day/SideWidgets';
import { EditWidgetsPanel, TaskStoryPanel } from '../my-day/MyDayPanels';
import { foldLayout, setHidden, toPrefs } from '../my-day/my-day-layout';
import type { LayoutGroup, MyDayLayout } from '../my-day/my-day-layout';
import {
  deriveCounts,
  pickNext,
  projectRows,
  splitWaiting,
  waitingId,
} from '../my-day/my-day-model';
import type { DueFilter, MyDayEntry } from '../my-day/my-day-model';
import { dayLine } from '../my-day/my-day-format';
import '../my-day/my-day.css';

export interface MyDayScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** Test and story seam: a fixed clock, so "today", "Now 11:24" and "3 days late" hold still. */
  now?: number;
}

/** The sheet open over My Day, if any: an approval decision or logging time on a row. */
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

/** The clock the page reads: fixed in a story, else the minute, refreshed every 30 s. */
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
 * **My Day v3.1** (spec MYDAY-V3-SPEC, Figma section `822:65257`, binding review §8 R1–R5).
 *
 * A dashboard of fourteen widgets on a 12-column grid: Today across the top; a Main stack of
 * 8 columns (Next, Due & at risk, By project, Briefing) beside a Side stack of 4 (At a glance,
 * Waiting, Timer, Getting started, Quick question); Saved, Pinned and Recent across the bottom.
 * Nothing on the page explains itself in a sentence: each widget's circled "i" holds its two.
 *
 * One ranked read feeds Next, At a glance, Due & at risk, Waiting, By project and the summary
 * line (`my-day-model.ts`), so their numbers cannot disagree (C4). Each widget loads and fails on
 * its own; the page-level line shows only when none of the three core reads answered. The widget
 * order and the hidden set are the person's own `home_widget_prefs` row, saved on every change.
 */
export function MyDayScreen({
  organizationSlug,
  organizationName,
  client,
  now: fixedNow,
}: MyDayScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const online = useOnline();
  const now = usePageClock(fixedNow);
  const [filter, setFilter] = useState<DueFilter>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [selected, setSelected] = useState<MyDayEntry | null>(null);
  const [editing, setEditing] = useState(false);
  const [touring, setTouring] = useState(false);
  const [completing, setCompleting] = useState<ReadonlySet<string>>(new Set());

  // 53-01: My Day refetches when the person's own work changes elsewhere, over the `me` topic.
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
  const projects = useQuery({
    queryKey: ['projects', organizationSlug],
    queryFn: () => listProjects(api, organizationSlug),
  });
  const prefs = useQuery({
    queryKey: ['home-widget-prefs', organizationSlug],
    queryFn: () => getHomeWidgetPrefs(api, organizationSlug),
    retry: false,
  });
  const today = useTodaySlots(api, organizationSlug, now);

  // ── The one ranked read (C4) ──────────────────────────────────────────────────────────
  const items = useMemo(() => myDay.data?.items ?? [], [myDay.data]);
  const split = useMemo(() => splitWaiting(waiting.data?.items ?? []), [waiting.data]);
  const pick = pickNext(items, split.onYou);
  const nextWorkId = pick?.kind === 'work' ? pick.entry.workItem.id : null;
  const nextWaitingId = pick?.kind === 'waiting' ? waitingId(pick.entry) : null;
  const counts = deriveCounts({
    summary: summary.data,
    items,
    waiting: split,
    waitingLoaded: waiting.isSuccess,
    meetings: today.meetingCount,
    now,
  });
  const byProject = useMemo(() => projectRows(items, split, now), [items, split, now]);

  const projectNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const project of projects.data ?? []) names.set(project.id, project.name);
    return names;
  }, [projects.data]);
  const ctx: WidgetContext = {
    slug: organizationSlug,
    now,
    projectName: (id) => projectNames.get(id) ?? t('MyDay.anotherProject'),
  };

  // ── Layout (Edit widgets) ─────────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<MyDayLayout | null>(null);
  const layout = draft ?? foldLayout(prefs.data);
  const save = useMutation({
    mutationFn: (next: MyDayLayout) => updateHomeWidgetPrefs(api, organizationSlug, toPrefs(next)),
    onSuccess: (view) => {
      queryClient.setQueryData(['home-widget-prefs', organizationSlug], view);
      setDraft(null);
    },
  });
  const changeLayout = (next: MyDayLayout) => {
    setDraft(next);
    save.mutate(next);
  };
  const hide = (id: HomeWidgetId) => changeLayout(setHidden(layout, id, true));

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

  const jump = (id: HomeWidgetId) => {
    const target = document.querySelector<HTMLElement>(`.tm-myday [data-widget="${id}"]`);
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  };

  // ── States ────────────────────────────────────────────────────────────────────────────
  const workState = queryState(myDay.isPending, myDay.isError);
  const waitingState = queryState(waiting.isPending, waiting.isError);
  const glanceState = queryState(
    summary.isPending && myDay.isPending,
    summary.isError && myDay.isError,
  );
  const todayState = queryState(today.isPending, today.isError);
  const allFailed = myDay.isError && waiting.isError && summary.isError;
  const nextMode: NextMode =
    pick !== null
      ? 'pick'
      : projects.isSuccess && projects.data.length === 0
        ? 'newMember'
        : 'allDone';

  const names: Record<HomeWidgetId, string> = {
    pulse: t('MyDay.w.today'),
    next: t('MyDay.w.next'),
    myDay: t('MyDay.w.due'),
    byProject: t('MyDay.w.byProject'),
    businessBriefing: t('MyDay.w.briefing'),
    summary: t('MyDay.w.glance'),
    waiting: t('MyDay.w.waiting'),
    timer: t('MyDay.w.timer'),
    gettingStarted: t('MyDay.w.gettingStarted'),
    quickQuestion: t('MyDay.w.quickQuestion'),
    savedContext: t('MyDay.w.saved'),
    pins: t('MyDay.w.pinned'),
    recent: t('MyDay.w.recent'),
  };

  const timedTitle = (workItemId: string): string | null =>
    items.find((entry) => entry.workItem.id === workItemId)?.workItem.title ?? null;

  const widget = (id: HomeWidgetId): ReactNode => {
    if (layout.hidden.has(id)) return null;
    switch (id) {
      case 'pulse':
        return (
          <TodayWidget
            key={id}
            ctx={ctx}
            slots={today.slots}
            state={todayState}
            onRetry={today.refetch}
          />
        );
      case 'next':
        return (
          <NextWidget
            key={id}
            ctx={ctx}
            pick={pick}
            mode={nextMode}
            state={
              pick === null
                ? queryState(myDay.isPending || waiting.isPending, myDay.isError)
                : 'ready'
            }
            onRetry={() => void myDay.refetch()}
            onDecide={(entry, intent, subject) =>
              setSheet({
                kind: 'approve',
                approvalId: entry.approvalId,
                version: entry.version,
                subject,
                intent,
              })
            }
          />
        );
      case 'summary':
        return (
          <GlanceWidget
            key={id}
            counts={counts}
            state={glanceState}
            onRetry={() => void summary.refetch()}
            onJump={jump}
          />
        );
      case 'myDay':
        return (
          <DueWidget
            key={id}
            ctx={ctx}
            items={items}
            counts={counts}
            nextWorkId={nextWorkId}
            filter={filter}
            onFilter={setFilter}
            state={workState}
            onRetry={() => void myDay.refetch()}
            selectedId={selected?.workItem.id ?? null}
            completing={completing}
            actions={{
              onComplete: (entry) => void complete(entry),
              onLogTime: (entry) =>
                setSheet({
                  kind: 'time',
                  workItemId: entry.workItem.id,
                  workTitle: entry.workItem.title,
                  projectName: ctx.projectName(entry.workItem.projectId),
                }),
              onStartTimer: (entry) => void startOn(entry),
              onSelect: (entry) =>
                setSelected((current) =>
                  current?.workItem.id === entry.workItem.id ? null : entry,
                ),
            }}
          />
        );
      case 'waiting':
        return (
          <WaitingWidget
            key={id}
            ctx={ctx}
            onYou={split.onYou}
            onOthers={split.onOthers}
            counts={counts}
            nextWaitingId={nextWaitingId}
            state={waitingState}
            onRetry={() => void waiting.refetch()}
          />
        );
      case 'byProject':
        return (
          <ByProjectWidget
            key={id}
            ctx={ctx}
            rows={byProject}
            state={workState}
            onRetry={() => void myDay.refetch()}
          />
        );
      case 'timer':
        return (
          <TimerWidget key={id} ctx={ctx} api={api} startOn={nextWorkId} timedTitle={timedTitle} />
        );
      case 'gettingStarted':
        return (
          <GettingStartedWidget
            key={id}
            ctx={ctx}
            api={api}
            onHide={() => hide('gettingStarted')}
            onTour={() => setTouring(true)}
          />
        );
      case 'businessBriefing':
        return (
          <BriefingWidget key={id} ctx={ctx} api={api} onHide={() => hide('businessBriefing')} />
        );
      case 'quickQuestion':
        return <QuickQuestionWidget key={id} ctx={ctx} api={api} />;
      case 'savedContext':
        return <SavedWidget key={id} ctx={ctx} api={api} />;
      case 'pins':
        return <PinnedWidget key={id} ctx={ctx} api={api} />;
      case 'recent':
        return <RecentWidget key={id} ctx={ctx} api={api} />;
    }
  };

  const group = (name: LayoutGroup) => layout.groups[name].map(widget);

  // The summary line: counts only, eight words at most (spec W0).
  const parts = [dayLine(locale, now)];
  if (counts.overdue > 0) parts.push(fill(t('MyDay.summaryOverdue'), { count: counts.overdue }));
  if (counts.waitingOnYou > 0) {
    parts.push(fill(t('MyDay.summaryWaiting'), { count: counts.waitingOnYou }));
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="home"
      title={t('MyDay.title')}
      header="titleRow"
      // R1: one Offline capsule, in the title row; the widgets carry none.
      actions={online ? null : <StateCapsule state="waiting">{t('MyDay.offline')}</StateCapsule>}
      description={
        <span className="tm-myday-summary">
          <span>{parts.join('\u2002·\u2002')}</span>
          <InfoButton
            title={t('MyDay.title')}
            label={fill(t('MyDay.about'), { title: t('MyDay.title') })}
          >
            {t('MyDay.info.myDay')}
          </InfoButton>
        </span>
      }
    >
      {allFailed ? (
        <div className="tm-myday-failed" role="alert">
          <span>{t('MyDay.pageFailed')}</span>
          <button
            type="button"
            className="tm-myday-link"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ['home'] })}
          >
            {t('MyDay.tryAgain')}
          </button>
        </div>
      ) : null}
      <div className="tm-myday" data-editing={editing || undefined}>
        <div className="tm-myday__top">{group('top')}</div>
        <div className="tm-myday__stack tm-myday__stack--main">{group('main')}</div>
        <div className="tm-myday__stack tm-myday__stack--side">{group('side')}</div>
        <div className="tm-myday__bottom">{group('bottom')}</div>
      </div>
      <div className="tm-myday__edit">
        <button
          type="button"
          className="tm-myday-link"
          aria-haspopup="dialog"
          aria-expanded={editing}
          onClick={() => setEditing(true)}
        >
          <NavIcon name="pencil" size={16} />
          {t('MyDay.editWidgets')}
        </button>
      </div>

      {editing ? (
        <EditWidgetsPanel
          layout={layout}
          names={names}
          onChange={changeLayout}
          onClose={() => setEditing(false)}
          failed={save.isError}
        />
      ) : null}
      {selected ? (
        <TaskStoryPanel
          api={api}
          slug={organizationSlug}
          entry={selected}
          projectName={ctx.projectName(selected.workItem.projectId)}
          onClose={() => setSelected(null)}
        />
      ) : null}
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
      {/* Spec §1 row 11: the tour no longer opens by itself; "Take the tour" starts it. */}
      {touring ? (
        <CoachMarkTour
          organizationSlug={organizationSlug}
          tour="my_day"
          onDemand={() => setTouring(false)}
          {...(client ? { client } : {})}
        />
      ) : null}
    </AppShell>
  );
}

function queryState(pending: boolean, error: boolean): WidgetState {
  if (pending) return 'loading';
  if (error) return 'error';
  return 'ready';
}
