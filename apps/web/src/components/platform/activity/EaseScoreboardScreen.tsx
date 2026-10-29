'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, StatusDot } from '@tmanage/ui';
import type { StatusTone } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  PERCENT_TARGETS,
  TIME_BUCKETS,
  TIMED_TASKS,
  bucketStanding,
  fetchEaseScoreboard,
  funnelSteps,
  isoWeekRange,
  measuresFor,
  medianBucket,
  percentStanding,
  scoreboardCsv,
  weeksOf,
} from '../../../lib/api/ease-scoreboard';
import type {
  EaseScoreboardView,
  FunnelId,
  LanguageFilter,
  Standing,
  TimeBucket,
  WeekMeasures,
} from '../../../lib/api/ease-scoreboard';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useT } from '../../../lib/i18n/use-t';
import { useTOr } from '../../../lib/i18n/use-t-or';
import type { ScreenProps } from '../shared/platform-kit';
import { PlatformGate } from '../shared/platform-kit';
import { PlatformPageState } from '../shared/PlatformPageState';
import { ACTIVITY_KEY, ActivityTabs } from './ActivityFrame';
import { EASE_COPY } from './ease-scoreboard-copy';
import type { EaseCopyKey } from './ease-scoreboard-copy';
import '../../../styles/screens/ease-scoreboard.css';

const WEEKS = 8;
const SCOREBOARD_KEY = [...ACTIVITY_KEY, 'ease-scoreboard', WEEKS] as const;

const STANDING_TONE: Record<Standing, StatusTone> = {
  on: 'success',
  close: 'warning',
  off: 'danger',
};
const STANDING_COPY: Record<Standing, EaseCopyKey> = {
  on: 'onTarget',
  close: 'close',
  off: 'offTarget',
};

const STEP_COPY: Record<string, EaseCopyKey> = {
  onboarding_step_completed_v1: 'stepOnboardingStarted',
  onboarding_completed_v1: 'stepOnboardingCompleted',
  first_project_created_v1: 'stepFirstProject',
  checklist_item_completed_v1: 'stepChecklist',
  magic_link_consumed_v1: 'stepMagicLink',
  portal_action_found_v1: 'stepPortalAction',
  approval_decided_v1: 'stepApproval',
  tour_step_viewed_v1: 'stepTour',
  quick_add_parsed_v1: 'stepQuickAdd',
  palette_used_v1: 'stepPalette',
  empty_state_action_v1: 'stepEmptyState',
};

const FUNNEL_TABS: readonly { id: FunnelId; tab: EaseCopyKey; title: EaseCopyKey }[] = [
  { id: 'signup', tab: 'tabSignup', title: 'funnelSignup' },
  { id: 'portal', tab: 'tabPortal', title: 'funnelPortal' },
  { id: 'firstWeek', tab: 'tabFirstWeek', title: 'funnelFirstWeek' },
];

const TASK_COPY: Record<(typeof TIMED_TASKS)[number]['id'], EaseCopyKey> = {
  T1: 'taskT1',
  T8: 'taskT8',
  setup: 'taskSetup',
};

type Copy = (key: EaseCopyKey) => string;

function useCopy(): Copy {
  const tOr = useTOr();
  return useCallback((key: EaseCopyKey) => tOr(`EaseScoreboard.${key}`, EASE_COPY[key]), [tOr]);
}

/**
 * 55-21 · Platform admin "Ease scoreboard" (Figma 444:21040 EN / 444:21528 AR): the week's four
 * ease measures against a baseline week, the sign-up / portal / first-week funnels, the task
 * timers and the English–Arabic gap — all derived from the API's aggregate rows, metadata only.
 */
export function EaseScoreboardScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const copy = useCopy();
  const [comparing, setComparing] = useState(false);
  return (
    <PlatformGate
      api={api}
      section="activity"
      crumbs={[t('PlatformActivity.crumb'), copy('title')]}
      title={copy('title')}
      description={copy('description')}
      actions={() => (
        <ScoreboardActions
          api={api}
          comparing={comparing}
          onToggleCompare={() => setComparing((value) => !value)}
        />
      )}
    >
      {() => (
        <div className="tm-stack">
          <ActivityTabs api={api} tab="ease" />
          <ScoreboardBody api={api} comparing={comparing} />
        </div>
      )}
    </PlatformGate>
  );
}

function useScoreboard(api: ApiClient) {
  return useQuery({
    queryKey: SCOREBOARD_KEY,
    queryFn: () => fetchEaseScoreboard(api, WEEKS),
  });
}

function ScoreboardActions({
  api,
  comparing,
  onToggleCompare,
}: {
  api: ApiClient;
  comparing: boolean;
  onToggleCompare: () => void;
}) {
  const copy = useCopy();
  const board = useScoreboard(api);
  const download = () => {
    if (!board.data) return;
    const blob = new Blob([scoreboardCsv(board.data)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ease-scoreboard-${board.data.since.slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <Button type="button" tone="outline" aria-pressed={comparing} onClick={onToggleCompare}>
        {copy('compareWeeks')}
      </Button>
      <Button type="button" tone="ink" disabled={!board.data} onClick={download}>
        {copy('downloadCsv')}
      </Button>
    </>
  );
}

function ScoreboardBody({ api, comparing }: { api: ApiClient; comparing: boolean }) {
  const copy = useCopy();
  const board = useScoreboard(api);
  if (board.isPending) return <PlatformPageState state="loading" />;
  if (board.isError) {
    return (
      <PlatformPageState state="error" error={board.error} onRetry={() => void board.refetch()} />
    );
  }
  const weeks = weeksOf(board.data);
  if (weeks.length === 0) {
    return <PlatformPageState state="empty" title={copy('emptyTitle')} body={copy('emptyBody')} />;
  }
  return <Scoreboard view={board.data} weeks={weeks} comparing={comparing} />;
}

function Scoreboard({
  view,
  weeks,
  comparing,
}: {
  view: EaseScoreboardView;
  weeks: readonly string[];
  comparing: boolean;
}) {
  const copy = useCopy();
  const format = useDisplayFormatters();
  const [language, setLanguage] = useState<LanguageFilter>('all');
  const [chosenBaseline, setBaseline] = useState<string | null>(null);
  const current = weeks[weeks.length - 1] ?? '';
  const baseline = chosenBaseline && weeks.includes(chosenBaseline) ? chosenBaseline : weeks[0];
  const weekLabel = useCallback(
    (week: string) => {
      const range = isoWeekRange(week);
      if (!range) return week;
      const day = (iso: string) => format.day(iso, { day: 'numeric', month: 'short' });
      return `${copy('week')} ${format.number(range.number)} · ${day(range.start)} – ${day(range.end)}`;
    },
    [copy, format],
  );
  const languages: readonly { id: LanguageFilter; key: EaseCopyKey }[] = [
    { id: 'all', key: 'allLanguages' },
    { id: 'en', key: 'english' },
    { id: 'ar', key: 'arabic' },
  ];
  return (
    <>
      <div className="tm-ease-filters" role="group" aria-label={copy('filtersLabel')}>
        <Badge mono>{weekLabel(current)}</Badge>
        {languages.map((item) => (
          <button
            key={item.id}
            type="button"
            className={language === item.id ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={language === item.id}
            onClick={() => setLanguage(item.id)}
          >
            {copy(item.key)}
          </button>
        ))}
      </div>
      {comparing ? (
        <div className="tm-ease-filters" role="group" aria-label={copy('baselineWeek')}>
          <span className="tm-cc-eyebrow">{copy('baselineWeek')}</span>
          {weeks.map((week) => (
            <button
              key={week}
              type="button"
              className={week === baseline ? 'tm-chip tm-chip--active' : 'tm-chip'}
              aria-pressed={week === baseline}
              onClick={() => setBaseline(week)}
            >
              {weekLabel(week)}
            </button>
          ))}
        </div>
      ) : null}
      <KpiTiles
        now={measuresFor(view, current, language)}
        before={baseline ? measuresFor(view, baseline, language) : null}
      />
      <div className="tm-cc-split tm-cc-split--even tm-cc-split--stretch">
        <FunnelCard
          view={view}
          weeks={weeks}
          baseline={baseline ?? null}
          language={language}
          baselineLabel={baseline ? weekLabel(baseline) : ''}
        />
        <TimersCard view={view} current={current} baseline={baseline ?? null} language={language} />
      </div>
      <LanguageCard view={view} current={current} />
      <p className="tm-ease-privacy">{copy('privacyNote')}</p>
    </>
  );
}

function useFigures() {
  const copy = useCopy();
  const format = useDisplayFormatters();
  return useMemo(
    () => ({
      percent: (value: number | null) =>
        value === null ? copy('noData') : `${format.number(value)} %`,
      bucket: (value: TimeBucket | null) =>
        value === null ? copy('noData') : copy(`bucket_${value}` as EaseCopyKey),
    }),
    [copy, format],
  );
}

function Standing({ value }: { value: Standing | null }) {
  const copy = useCopy();
  if (value === null) return null;
  return <StatusDot tone={STANDING_TONE[value]}>{copy(STANDING_COPY[value])}</StatusDot>;
}

function KpiTiles({ now, before }: { now: WeekMeasures; before: WeekMeasures | null }) {
  const copy = useCopy();
  const figures = useFigures();
  const tiles = [
    {
      id: 'ttfp',
      label: copy('ttfp'),
      value: figures.bucket(now.timeToFirstProject),
      was: before ? figures.bucket(before.timeToFirstProject) : null,
      note: copy('ttfpTarget'),
      standing: bucketStanding(now.timeToFirstProject, TIMED_TASKS[0].target),
    },
    {
      id: 'activation',
      label: copy('activation'),
      value: figures.percent(now.activation),
      was: before ? figures.percent(before.activation) : null,
      note: copy('activationNote'),
      standing: percentStanding(now.activation, PERCENT_TARGETS.activation),
    },
    {
      id: 'task-success',
      label: copy('taskSuccess'),
      value: figures.percent(now.taskSuccess),
      was: before ? figures.percent(before.taskSuccess) : null,
      note: copy('taskSuccessNote'),
      standing: percentStanding(now.taskSuccess, PERCENT_TARGETS.taskSuccess),
    },
    {
      id: 'help',
      label: copy('helpDeflection'),
      value: figures.percent(now.helpDeflection),
      was: before ? figures.percent(before.helpDeflection) : null,
      note: copy('helpDeflectionNote'),
      standing: percentStanding(now.helpDeflection, PERCENT_TARGETS.helpDeflection),
    },
  ];
  return (
    <ul className="tm-cc-metrics tm-ease-kpis" aria-label={copy('kpiLabel')}>
      {tiles.map((tile) => (
        <li key={tile.id} className="tm-cc-metric">
          <p className="tm-cc-metric__source">{tile.label}</p>
          <p className="tm-cc-metric__value">{tile.value}</p>
          <p className="tm-ease-sub">
            {tile.was !== null ? `${copy('was')} ${tile.was} · ` : ''}
            {tile.note}
          </p>
          <Standing value={tile.standing} />
        </li>
      ))}
    </ul>
  );
}

function FunnelCard({
  view,
  weeks,
  baseline,
  language,
  baselineLabel,
}: {
  view: EaseScoreboardView;
  weeks: readonly string[];
  baseline: string | null;
  language: LanguageFilter;
  baselineLabel: string;
}) {
  const copy = useCopy();
  const format = useDisplayFormatters();
  const [funnel, setFunnel] = useState<FunnelId>('signup');
  const active = FUNNEL_TABS.find((item) => item.id === funnel) ?? FUNNEL_TABS[0];
  const steps = funnelSteps(view, funnel, weeks, baseline, language);
  return (
    <section className="tm-cc-card" aria-labelledby="tm-ease-funnel-title">
      <h2 id="tm-ease-funnel-title" className="tm-cc-card__title">
        {copy(active?.title ?? 'funnelSignup')} ·{' '}
        {copy('lastWeeks').replace('{n}', format.number(view.weeks))}
      </h2>
      <div className="tm-ease-filters" role="group" aria-label={copy('funnelSignup')}>
        {FUNNEL_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === funnel ? 'tm-chip tm-chip--active' : 'tm-chip'}
            aria-pressed={item.id === funnel}
            onClick={() => setFunnel(item.id)}
          >
            {copy(item.tab)}
          </button>
        ))}
      </div>
      <p className="tm-ease-legend">
        <span className="tm-ease-legend__now" aria-hidden="true" />
        {copy('now')}
        <span className="tm-ease-legend__base" aria-hidden="true" />
        {copy('baseline')} · {baselineLabel}
      </p>
      <ol className="tm-ease-funnel">
        {steps.map((step) => (
          <li key={step.eventName} className="tm-ease-funnel__step">
            <span className="tm-ease-funnel__label">
              {copy(STEP_COPY[step.eventName] ?? 'noData')}
            </span>
            <span className="tm-ease-funnel__bars" aria-hidden="true">
              <span className="tm-cc-bar tm-ease-bar">
                <span className="tm-cc-bar__fill" style={{ inlineSize: `${step.nowPercent}%` }} />
              </span>
              <span className="tm-cc-bar tm-ease-bar tm-ease-bar--base">
                <span
                  className="tm-cc-bar__fill"
                  style={{ inlineSize: `${step.baselinePercent}%` }}
                />
              </span>
            </span>
            <span className="tm-ease-funnel__figure">
              {format.number(step.nowPercent)} % · {format.number(step.now)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TimersCard({
  view,
  current,
  baseline,
  language,
}: {
  view: EaseScoreboardView;
  current: string;
  baseline: string | null;
  language: LanguageFilter;
}) {
  const copy = useCopy();
  const figures = useFigures();
  return (
    <section className="tm-cc-card" aria-labelledby="tm-ease-timers-title">
      <h2 id="tm-ease-timers-title" className="tm-cc-card__title">
        {copy('timersTitle')} · {copy('medianTime')}
      </h2>
      <table className="tm-table tm-cc-table tm-ease-table">
        <thead>
          <tr>
            <th scope="col">{copy('colTask')}</th>
            <th scope="col">{copy('colBefore')}</th>
            <th scope="col">{copy('colNow')}</th>
            <th scope="col">{copy('colTarget')}</th>
            <th scope="col">{copy('colStatus')}</th>
          </tr>
        </thead>
        <tbody>
          {TIMED_TASKS.map((task) => {
            const now = medianBucket(view, task.eventName, current, language);
            const before = baseline ? medianBucket(view, task.eventName, baseline, language) : null;
            return (
              <tr key={task.id}>
                <th scope="row">
                  {task.id === 'setup' ? null : (
                    <>
                      <bdi dir="ltr">{task.id}</bdi> ·{' '}
                    </>
                  )}
                  {copy(TASK_COPY[task.id])}
                </th>
                <td className="tm-cc-cell-mono">{figures.bucket(before)}</td>
                <td className="tm-cc-cell-mono">{figures.bucket(now)}</td>
                <td className="tm-cc-cell-mono">{figures.bucket(task.target)}</td>
                <td>
                  <Standing value={bucketStanding(now, task.target)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function LanguageCard({ view, current }: { view: EaseScoreboardView; current: string }) {
  const copy = useCopy();
  const format = useDisplayFormatters();
  const figures = useFigures();
  const en = measuresFor(view, current, 'en');
  const ar = measuresFor(view, current, 'ar');
  const percentGap = (a: number | null, b: number | null) => {
    if (a === null || b === null) return '—';
    const gap = b - a;
    return gap === 0
      ? copy('same')
      : `${gap > 0 ? '+' : '−'}${format.number(Math.abs(gap))} ${copy('pts')}`;
  };
  const bucketGap = (a: TimeBucket | null, b: TimeBucket | null) => {
    if (a === null || b === null) return '—';
    const gap = TIME_BUCKETS.indexOf(b) - TIME_BUCKETS.indexOf(a);
    return gap === 0
      ? copy('same')
      : `${gap > 0 ? '+' : '−'}${format.number(Math.abs(gap))} ${copy('bands')}`;
  };
  const rows = [
    {
      id: 'ttfp',
      label: copy('ttfp'),
      en: figures.bucket(en.timeToFirstProject),
      ar: figures.bucket(ar.timeToFirstProject),
      gap: bucketGap(en.timeToFirstProject, ar.timeToFirstProject),
    },
    ...(['activation', 'taskSuccess', 'helpDeflection'] as const).map((key) => ({
      id: key,
      label: copy(key),
      en: figures.percent(en[key]),
      ar: figures.percent(ar[key]),
      gap: percentGap(en[key], ar[key]),
    })),
  ];
  return (
    <section className="tm-cc-card" aria-labelledby="tm-ease-language-title">
      <h2 id="tm-ease-language-title" className="tm-cc-card__title">
        {copy('byLanguageTitle')} · {copy('thisWeek')}
      </h2>
      <table className="tm-table tm-cc-table tm-ease-table">
        <thead>
          <tr>
            <th scope="col">{copy('colMeasure')}</th>
            <th scope="col">{copy('colEnglish')}</th>
            <th scope="col">{copy('colArabic')}</th>
            <th scope="col">{copy('colGap')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              <td className="tm-cc-cell-mono">{row.en}</td>
              <td className="tm-cc-cell-mono">{row.ar}</td>
              <td className="tm-cc-cell-mono">{row.gap}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
