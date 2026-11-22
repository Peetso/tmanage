'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { InfoButton } from '@tmanage/ui';
import { NavIcon } from '../icons/phone';
import type { PhoneIconName } from '../icons/phone';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { getRecentItems, getHomePins, getSavedContext } from '../../lib/api/home';
import { getWorkItem } from '../../lib/api/work-items';
import { getProject } from '../../lib/api/projects';
import { getDocument } from '../../lib/api/documents';
import { getMeetingOverview } from '../../lib/api/meetings';
import { readMyTimesheet } from '../../lib/api/finance-core';
import { startTimer } from '../../lib/api/time-timer';
import { getAutoTracking, updateAutoTrackingSettings } from '../../lib/api/time-auto';
import { activitySupport, requestIdleDetection } from '../../lib/activity-sources';
import { dismissGettingStarted, getGettingStarted, STEP_HREF } from '../../lib/api/getting-started';
import { getHomeBriefing, hasBriefing, homeBriefingQueryKey } from '../../lib/api/home-briefing';
import {
  answerPricingSurvey,
  PRICING_BAND_VALUES,
  PRICING_NOTE_MAX,
  skipPricingSurvey,
} from '../../lib/api/pricing-survey';
import type { PricingBand } from '../../lib/api/pricing-survey';
import { isTimerRunningConflict } from '../../lib/timer-state';
import { fill } from '../../lib/privacy-presentation';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import type { MessageKey } from '../../lib/i18n/t';
import { gettingStartedQueryKey, STEP_LABEL } from '../onboarding/GettingStartedCard';
import { pricingSurveyKey, pricingSurveyQuery } from '../screens/pricing-survey-query';
import { StopTimerDialog } from '../time/TimerControls';
import { timerKey, useRunningTimer } from '../time/use-running-timer';
import { autoTrackingKey } from '../time/use-auto-tracker';
import { AllToggle, MyDayWidget } from './MyDayWidget';
import { RowMenu } from './WorkWidgets';
import type { WidgetContext } from './WorkWidgets';
import { clock, duration, elapsedFace, localDay } from './my-day-format';
import { LIST_ROWS } from './my-day-model';

/* ── W8 Timer ───────────────────────────────────────────────────────────────────────────── */

export function TimerWidget({
  ctx,
  api,
  startOn,
  timedTitle,
}: {
  readonly ctx: WidgetContext;
  readonly api: ApiClient;
  /** The work item Start times: the Next item when it is a task, else none. */
  readonly startOn: string | null;
  /** The running timer's task name, when the page knows it. */
  readonly timedTitle: (workItemId: string) => string | null;
}) {
  const t = useT();
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const { timer, elapsedSeconds, roundingMinutes, isPending } = useRunningTimer(api, ctx.slug);
  const [stopping, setStopping] = useState(false);
  const autoId = useId();
  const sheet = useQuery({
    queryKey: ['finance-timesheet-mine', ctx.slug, undefined],
    queryFn: () => readMyTimesheet(api, ctx.slug),
    retry: false,
  });
  const today = localDay(ctx.now);
  const loggedMinutes = (sheet.data?.groups ?? [])
    .flatMap((group) => group.entries)
    .filter((entry) => entry.spentOn === today)
    .reduce((total, entry) => total + entry.minutes, 0);
  const totalMinutes = loggedMinutes + (timer ? Math.floor(elapsedSeconds / 60) : 0);

  const start = useMutation({
    mutationFn: () => startTimer(api, ctx.slug, startOn === null ? {} : { workItemId: startOn }),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: timerKey(ctx.slug) });
    },
  });

  const auto = useQuery({
    queryKey: autoTrackingKey(ctx.slug),
    queryFn: () => getAutoTracking(api, ctx.slug),
    retry: false,
  });
  const autoSwitch = useMutation({
    mutationFn: async (enabled: boolean) => {
      const view = await updateAutoTrackingSettings(api, ctx.slug, { enabled });
      // Chrome and Edge ask once for idle detection; the browser shows its own prompt.
      if (enabled && activitySupport() === 'idle-detector') await requestIdleDetection();
      return view;
    },
    onSuccess: (view) => queryClient.setQueryData(autoTrackingKey(ctx.slug), view),
  });
  const policy = auto.data?.policy;

  const title = timer?.workItemId ? timedTitle(timer.workItemId) : null;
  const state = isPending ? 'loading' : 'ready';

  return (
    <MyDayWidget
      id="timer"
      title={t('MyDay.w.timer')}
      info={t('MyDay.info.timer')}
      state={state}
      skeletonRows={2}
      skeletonHeight="32px"
      className="tm-myday-w--timer"
    >
      <div className="tm-myday-timer">
        {timer ? (
          <>
            <span className="tm-myday-timer__dot" aria-hidden="true" />
            <span className="tm-myday-timer__text">
              <span className="tm-myday-timer__task">{title ?? t('MyDay.timerTask')}</span>
              <span className="tm-myday-row__meta">
                {fill(t('MyDay.todayTotal'), { time: duration(tOr, totalMinutes) })}
              </span>
            </span>
            <span className="tm-myday-timer__face">{elapsedFace(elapsedSeconds)}</span>
            <button
              type="button"
              className="tm-button tm-button--outline tm-button--compact"
              onClick={() => setStopping(true)}
            >
              {t('MyDay.stop')}
            </button>
          </>
        ) : (
          <>
            <span className="tm-myday-timer__text">
              <span className="tm-myday-timer__task">
                {totalMinutes > 0
                  ? fill(t('MyDay.todayTotal'), { time: duration(tOr, totalMinutes) })
                  : t('MyDay.noTimeToday')}
              </span>
            </span>
            <button
              type="button"
              className="tm-button tm-button--outline tm-button--compact"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              {t('MyDay.start')}
            </button>
          </>
        )}
      </div>
      {start.isError && !isTimerRunningConflict(start.error) ? (
        <div className="tm-myday-w__line" role="alert">
          {t('MyDay.loadFailed')}
        </div>
      ) : null}
      {policy !== undefined && policy !== 'off' ? (
        <div className="tm-myday-auto">
          <label className="tm-myday-auto__label" htmlFor={autoId}>
            {t('MyDay.autoTimer')}
          </label>
          <AutoTimerInfo />
          <span className="tm-myday-w__spacer" />
          <input
            id={autoId}
            type="checkbox"
            role="switch"
            className="tm-switch"
            checked={auto.data?.enabled ?? false}
            disabled={policy === 'required' || autoSwitch.isPending}
            onChange={(event) => autoSwitch.mutate(event.target.checked)}
          />
        </div>
      ) : null}
      {stopping && timer ? (
        <StopTimerDialog
          api={api}
          organizationSlug={ctx.slug}
          initialNote={timer.note ?? ''}
          elapsedSeconds={elapsedSeconds}
          roundingMinutes={roundingMinutes}
          subject={title}
          onClose={() => setStopping(false)}
          tr={tOr}
        />
      ) : null}
    </MyDayWidget>
  );
}

function AutoTimerInfo() {
  const t = useT();
  const title = t('MyDay.autoTimer');
  // Spec §5 row 13: the Auto timer row carries its own circled "i".
  return (
    <InfoButton title={title} label={fill(t('MyDay.about'), { title })}>
      {t('MyDay.info.autoTimer')}
    </InfoButton>
  );
}

/* ── W9 Getting started ─────────────────────────────────────────────────────────────────── */

export function GettingStartedWidget({
  ctx,
  api,
  onHide,
  onTour,
}: {
  readonly ctx: WidgetContext;
  readonly api: ApiClient;
  /** "⋯ › Hide": the widget leaves My Day and is listed in Edit widgets. */
  readonly onHide: () => void;
  /** "Take the tour": the My Day coach marks, on demand. */
  readonly onTour: () => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: gettingStartedQueryKey(ctx.slug),
    queryFn: () => getGettingStarted(api, ctx.slug),
    retry: false,
  });
  const dismiss = useMutation({
    mutationFn: () => dismissGettingStarted(api, ctx.slug),
    onSuccess: (next) => queryClient.setQueryData(gettingStartedQueryKey(ctx.slug), next),
  });
  const data = view.data;
  // Done or dismissed: the widget leaves the page (spec W9) and stays listed in Edit widgets.
  if (data && (data.dismissed || data.completedCount >= data.totalCount)) return null;
  const next = data?.nextStep ?? null;
  const share = data && data.totalCount > 0 ? data.completedCount / data.totalCount : 0;
  return (
    <MyDayWidget
      id="gettingStarted"
      title={t('MyDay.w.gettingStarted')}
      info={t('MyDay.info.gettingStarted')}
      actions={
        <RowMenu
          label={fill(t('MyDay.rowMore'), { title: t('MyDay.w.gettingStarted') })}
          items={[
            {
              id: 'hide',
              label: t('MyDay.hide'),
              onSelect: () => {
                onHide();
                dismiss.mutate();
              },
            },
          ]}
        />
      }
      state={view.isPending ? 'loading' : view.isError ? 'error' : 'ready'}
      skeletonRows={2}
      skeletonHeight="32px"
      onRetry={() => void view.refetch()}
    >
      <div className="tm-myday-progress">
        <span className="tm-myday-progress__count">
          {fill(t('MyDay.stepsDone'), {
            done: data?.completedCount ?? 0,
            total: data?.totalCount ?? 0,
          })}
        </span>
        <span
          className="tm-myday-progress__bar"
          role="progressbar"
          aria-label={t('MyDay.w.gettingStarted')}
          aria-valuemin={0}
          aria-valuemax={data?.totalCount ?? 0}
          aria-valuenow={data?.completedCount ?? 0}
        >
          <span
            className="tm-myday-progress__fill"
            style={{ inlineSize: `${Math.round(share * 100)}%` }}
          />
        </span>
      </div>
      <div className="tm-myday-gs__foot">
        {next ? (
          <Link
            href={`/${ctx.slug}${STEP_HREF[next]}`}
            className="tm-button tm-button--outline tm-button--compact"
          >
            {tOr(...STEP_LABEL[next])}
          </Link>
        ) : (
          <span />
        )}
        <button type="button" className="tm-myday-link" onClick={onTour}>
          {t('MyDay.takeTour')}
        </button>
      </div>
    </MyDayWidget>
  );
}

/* ── W10 Briefing ───────────────────────────────────────────────────────────────────────── */

export function BriefingWidget({
  ctx,
  api,
  onHide,
}: {
  readonly ctx: WidgetContext;
  readonly api: ApiClient;
  readonly onHide: () => void;
}) {
  const t = useT();
  const tOr = useTOr();
  const briefing = useQuery({
    queryKey: homeBriefingQueryKey(ctx.slug),
    queryFn: () => getHomeBriefing(api, ctx.slug),
    retry: false,
  });
  // P: members without a briefing never see the widget (spec W10).
  if (briefing.isSuccess && !hasBriefing(briefing.data)) return null;
  const groups = (briefing.data?.groups ?? []).filter((group) => group.count > 0);
  const shown = groups.slice(0, 4);
  const asOf = briefing.data?.asOf ?? null;
  const state = briefing.isPending
    ? 'loading'
    : briefing.isError
      ? 'error'
      : groups.length === 0
        ? 'empty'
        : 'ready';
  return (
    <MyDayWidget
      id="businessBriefing"
      title={t('MyDay.w.briefing')}
      info={t('MyDay.info.briefing')}
      actions={
        <>
          {asOf ? (
            <span className="tm-myday-w__meta">
              {fill(t('MyDay.updatedAt'), { time: clock(asOf) })}
            </span>
          ) : null}
          <RowMenu
            label={fill(t('MyDay.rowMore'), { title: t('MyDay.w.briefing') })}
            items={[{ id: 'hide', label: t('MyDay.hide'), onSelect: onHide }]}
          />
        </>
      }
      state={state}
      empty={t('MyDay.nothingNeedsAttention')}
      skeletonRows={1}
      skeletonHeight="72px"
      onRetry={() => void briefing.refetch()}
    >
      <ul className="tm-myday-tiles tm-myday-tiles--briefing">
        {shown.map((group) => (
          <li key={group.group}>
            <Link href={`/${ctx.slug}${group.path}`} className="tm-myday-tile">
              <span className="tm-myday-tile__value">{group.count}</span>
              <span className="tm-myday-tile__label">
                {tOr(`HomeBriefing.group.${group.group}`, group.group)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </MyDayWidget>
  );
}

/* ── W11 Quick question ─────────────────────────────────────────────────────────────────── */

/**
 * Each answer is a phrase around one amount ("Under {amount}"). The amounts are the server's
 * bands (`PricingBand`) and are never translated; R4 isolates them left to right.
 */
const BANDS: Readonly<Record<PricingBand, readonly [MessageKey, string]>> = {
  nothing: ['MyDay.band.nothing', '$0'],
  under_5: ['MyDay.band.under_5', '$5'],
  '5_9': ['MyDay.band.5_9', '$5–9'],
  '10_15': ['MyDay.band.10_15', '$10–15'],
  over_15: ['MyDay.band.over_15', '$15'],
};

function BandLabel({ band }: { readonly band: PricingBand }) {
  const t = useT();
  const [key, amount] = BANDS[band];
  const [before = '', after = ''] = t(key).split('{amount}');
  // One inline run: inside the flex button a bare text node would lose its edge space.
  return (
    <span>
      {before}
      {/* R4: the amount is isolated left to right, so "$5–9" never reorders in Arabic. */}
      <bdi dir="ltr">{amount}</bdi>
      {after}
    </span>
  );
}

export function QuickQuestionWidget({
  ctx,
  api,
}: {
  readonly ctx: WidgetContext;
  readonly api: ApiClient;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const noteId = useId();
  const [band, setBand] = useState<PricingBand | null>(null);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<'answered' | 'skipped' | null>(null);
  const survey = useQuery(pricingSurveyQuery(api, ctx.slug));

  const settle = (outcome: 'answered' | 'skipped') => {
    setResult(outcome);
    queryClient.setQueryData(pricingSurveyKey(ctx.slug), { show: false });
  };
  // 409: answered in another tab; the question is closed, so it simply goes.
  const closedElsewhere = (error: unknown) =>
    error instanceof ApiRequestError && error.status === 409;
  const send = useMutation({
    mutationFn: (chosen: PricingBand) =>
      answerPricingSurvey(api, ctx.slug, {
        band: chosen,
        note: note.trim() === '' ? null : note.trim(),
      }),
    onSuccess: () => settle('answered'),
    onError: (error) => {
      if (closedElsewhere(error)) settle('skipped');
    },
  });
  const skip = useMutation({
    mutationFn: () => skipPricingSurvey(api, ctx.slug),
    onSuccess: () => settle('skipped'),
    onError: (error) => {
      if (closedElsewhere(error)) settle('skipped');
    },
  });

  if (result === 'skipped') return null;
  if (result === null && survey.data?.show !== true) return null;
  const failed =
    (send.isError && !closedElsewhere(send.error)) ||
    (skip.isError && !closedElsewhere(skip.error));

  return (
    <MyDayWidget
      id="quickQuestion"
      title={t('MyDay.w.quickQuestion')}
      info={t('MyDay.info.quickQuestion')}
      actions={
        result === null ? (
          <button
            type="button"
            className="tm-myday-link"
            disabled={skip.isPending || send.isPending}
            onClick={() => skip.mutate()}
          >
            {t('MyDay.skip')}
          </button>
        ) : null
      }
      state="ready"
    >
      {result === 'answered' ? (
        <div className="tm-myday-w__line" role="status">
          {t('MyDay.thankYou')}
        </div>
      ) : (
        <>
          <div className="tm-myday-question" id={`${noteId}-q`}>
            {t('MyDay.question')}
          </div>
          <div className="tm-myday-bands" role="radiogroup" aria-labelledby={`${noteId}-q`}>
            {PRICING_BAND_VALUES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={band === value}
                className="tm-myday-band"
                onClick={() => setBand(value)}
              >
                <BandLabel band={value} />
              </button>
            ))}
          </div>
          {band !== null ? (
            <div className="tm-myday-question__send">
              <label className="tm-visually-hidden" htmlFor={noteId}>
                {t('MyDay.noteLabel')}
              </label>
              <input
                id={noteId}
                className="tm-myday-question__note"
                value={note}
                maxLength={PRICING_NOTE_MAX}
                placeholder={t('MyDay.noteLabel')}
                onChange={(event) => setNote(event.target.value)}
              />
              <button
                type="button"
                className="tm-button tm-button--outline tm-button--compact"
                disabled={send.isPending}
                onClick={() => send.mutate(band)}
              >
                {t('MyDay.send')}
              </button>
            </div>
          ) : null}
          {failed ? (
            <div className="tm-myday-w__line" role="alert">
              {t('MyDay.saveFailed')}
            </div>
          ) : null}
        </>
      )}
    </MyDayWidget>
  );
}

/* ── W12–W14 Saved, Pinned, Recent ──────────────────────────────────────────────────────── */

type RefKind = 'work' | 'project' | 'document' | 'deliverable' | 'meeting' | 'message' | 'file';

interface RefRow {
  readonly id: string;
  readonly kind: RefKind;
  readonly targetId: string;
  /** The project the API grouped it under, when it says (saved context). */
  readonly projectId: string | null;
  /** The time shown at the row's end (Recent only). */
  readonly at: string | null;
  /**
   * The name the API already resolved through the source's own gate (Saved). `undefined` means
   * "resolve it here" (Pinned, Recent); `null` means the viewer may not see it: show the kind word.
   */
  readonly title?: string | null;
}

const KIND_ICON: Readonly<Record<RefKind, PhoneIconName>> = {
  work: 'squareCheck',
  project: 'layers',
  document: 'file',
  deliverable: 'file',
  meeting: 'calendar',
  message: 'chat',
  file: 'file',
};

const KIND_KEY: Readonly<Record<RefKind, MessageKey>> = {
  work: 'MyDay.kind.work',
  project: 'MyDay.kind.project',
  document: 'MyDay.kind.doc',
  deliverable: 'MyDay.kind.doc',
  meeting: 'MyDay.kind.meeting',
  message: 'MyDay.kind.message',
  file: 'MyDay.kind.file',
};

function refHref(slug: string, row: RefRow): string | null {
  const id = encodeURIComponent(row.targetId);
  switch (row.kind) {
    case 'work':
      return `/${slug}/work/${id}`;
    case 'project':
      return `/${slug}/projects/${id}`;
    case 'document':
      return `/${slug}/docs/${id}`;
    case 'meeting':
      return `/${slug}/calendar/meetings/${id}`;
    case 'file':
      return `/${slug}/files/${id}`;
    // A saved deliverable is a version: its project's deliverables list holds it.
    case 'deliverable':
      return row.projectId
        ? `/${slug}/projects/${encodeURIComponent(row.projectId)}/deliverables`
        : null;
    case 'message':
      return row.projectId ? `/${slug}/projects/${encodeURIComponent(row.projectId)}` : null;
  }
}

/**
 * The live name of a reference, read through the object's own authorized GET, so the row shows
 * the real name (spec W12) and nothing a person could not open anyway: a refusal or a 404 falls
 * back to the kind word. Messages and files have no single read, so they keep the kind word.
 */
async function refName(
  api: ApiClient,
  slug: string,
  kind: RefKind,
  id: string,
): Promise<{ readonly name: string; readonly projectId: string | null } | null> {
  try {
    switch (kind) {
      case 'work': {
        const item = await getWorkItem(api, slug, id);
        return { name: item.title, projectId: item.projectId };
      }
      case 'project':
        return { name: (await getProject(api, slug, id)).name, projectId: null };
      case 'document': {
        const doc = await getDocument(api, slug, id);
        return { name: doc.title, projectId: doc.projectId };
      }
      case 'meeting': {
        const meeting = (await getMeetingOverview(api, slug, id)).meeting;
        return { name: meeting.title, projectId: meeting.projectId };
      }
      case 'message':
      case 'file':
      case 'deliverable':
        return null;
    }
  } catch {
    return null;
  }
}

function RefList({
  ctx,
  api,
  rows,
  timed,
}: {
  readonly ctx: WidgetContext;
  readonly api: ApiClient;
  readonly rows: readonly RefRow[];
  readonly timed: boolean;
}) {
  const t = useT();
  const names = useQueries({
    queries: rows.map((row) => ({
      queryKey: ['home', 'ref-name', ctx.slug, row.kind, row.targetId],
      queryFn: () => refName(api, ctx.slug, row.kind, row.targetId),
      enabled: row.title === undefined && row.kind !== 'message' && row.kind !== 'file',
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  return (
    <ul className="tm-myday-rows tm-myday-rows--refs">
      {rows.map((row, index) => {
        const query = names[index];
        // FIX5 6d: a reference whose object answered "not found" or "not yours" is left out,
        // never drawn as a row the person cannot open.
        if (query?.isSuccess && query.data === null) return null;
        const resolved = query?.data ?? null;
        const name =
          (row.title === undefined ? resolved?.name : row.title) ?? t(KIND_KEY[row.kind]);
        const projectId = resolved?.projectId ?? row.projectId;
        const meta =
          row.kind === 'project'
            ? t('MyDay.kind.project')
            : projectId
              ? ctx.projectName(projectId)
              : t(KIND_KEY[row.kind]);
        const href = refHref(ctx.slug, row);
        return (
          <li key={row.id} className="tm-myday-row tm-myday-row--ref">
            <NavIcon name={KIND_ICON[row.kind]} size={16} className="tm-myday-row__kind" />
            <span className="tm-myday-row__text">
              {href ? (
                <Link href={href} className="tm-myday-row__name">
                  {name}
                </Link>
              ) : (
                <span className="tm-myday-row__name">{name}</span>
              )}
              <span className="tm-myday-row__meta">{meta}</span>
            </span>
            {timed && row.at ? <span className="tm-myday-row__time">{clock(row.at)}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

export function SavedWidget({
  ctx,
  api,
}: {
  readonly ctx: WidgetContext;
  readonly api: ApiClient;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const saved = useQuery({
    queryKey: ['home', 'saved-context', ctx.slug],
    queryFn: () => getSavedContext(api, ctx.slug),
  });
  const all = useMemo<RefRow[]>(
    () =>
      (saved.data?.groups ?? []).flatMap((group) =>
        group.items.map((item) => ({
          id: item.id,
          kind: item.entityType === 'doc' ? 'deliverable' : item.entityType,
          targetId: item.entityId,
          projectId: group.projectId,
          at: item.createdAt,
          title: item.title,
        })),
      ),
    [saved.data],
  );
  return (
    <MyDayWidget
      id="savedContext"
      title={t('MyDay.w.saved')}
      info={t('MyDay.info.saved')}
      actions={
        all.length > LIST_ROWS.shortcuts ? (
          <AllToggle
            count={all.length}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
          />
        ) : null
      }
      state={
        saved.isPending ? 'loading' : saved.isError ? 'error' : all.length === 0 ? 'empty' : 'ready'
      }
      empty={t('MyDay.nothingSaved')}
      skeletonRows={3}
      onRetry={() => void saved.refetch()}
    >
      <RefList
        ctx={ctx}
        api={api}
        rows={expanded ? all : all.slice(0, LIST_ROWS.shortcuts)}
        timed={false}
      />
    </MyDayWidget>
  );
}

export function PinnedWidget({
  ctx,
  api,
}: {
  readonly ctx: WidgetContext;
  readonly api: ApiClient;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const pins = useQuery({
    queryKey: ['home', 'pins', ctx.slug],
    queryFn: () => getHomePins(api, ctx.slug),
  });
  const all = useMemo<RefRow[]>(
    () =>
      (pins.data?.pins ?? []).map((pin) => ({
        id: pin.id,
        kind: pin.targetKind,
        targetId: pin.targetId,
        projectId: null,
        at: pin.createdAt,
      })),
    [pins.data],
  );
  return (
    <MyDayWidget
      id="pins"
      title={t('MyDay.w.pinned')}
      info={t('MyDay.info.pinned')}
      actions={
        all.length > LIST_ROWS.shortcuts ? (
          <AllToggle
            count={all.length}
            expanded={expanded}
            onToggle={() => setExpanded(!expanded)}
          />
        ) : null
      }
      state={
        pins.isPending ? 'loading' : pins.isError ? 'error' : all.length === 0 ? 'empty' : 'ready'
      }
      empty={t('MyDay.nothingPinned')}
      skeletonRows={3}
      onRetry={() => void pins.refetch()}
    >
      <RefList
        ctx={ctx}
        api={api}
        rows={expanded ? all : all.slice(0, LIST_ROWS.shortcuts)}
        timed={false}
      />
    </MyDayWidget>
  );
}

export function RecentWidget({
  ctx,
  api,
}: {
  readonly ctx: WidgetContext;
  readonly api: ApiClient;
}) {
  const t = useT();
  const recents = useQuery({
    queryKey: ['home', 'recent-items', ctx.slug],
    queryFn: () => getRecentItems(api, ctx.slug),
  });
  const all = useMemo<RefRow[]>(
    () =>
      (recents.data?.items ?? []).map((item) => ({
        id: item.id,
        kind: item.objectType,
        targetId: item.objectId,
        projectId: null,
        at: item.viewedAt,
      })),
    [recents.data],
  );
  return (
    <MyDayWidget
      id="recent"
      title={t('MyDay.w.recent')}
      info={t('MyDay.info.recent')}
      state={
        recents.isPending
          ? 'loading'
          : recents.isError
            ? 'error'
            : all.length === 0
              ? 'empty'
              : 'ready'
      }
      empty={t('MyDay.nothingOpened')}
      skeletonRows={3}
      onRetry={() => void recents.refetch()}
    >
      <RefList ctx={ctx} api={api} rows={all.slice(0, LIST_ROWS.shortcuts)} timed />
    </MyDayWidget>
  );
}
