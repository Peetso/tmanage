'use client';

import { useCallback, type ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, StatusDot, type CapsuleState } from '@tmanage/ui';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useDisplayFormatters, type DisplayFormatters } from '../../../../lib/i18n/use-formatters';
import { useT } from '../../../../lib/i18n/use-t';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Mini product scenes for Features · Insights & automations (WEB-06). Each one is composed from
 * packages/ui parts (StateCapsule, StatusDot, Badge, Avatar, Button) and token-only classes in
 * `features-insights.css`. Like the shared scenes, the body is `inert` and hidden from assistive
 * tech; `label` gives one sentence of alternative text.
 *
 * Every visible string is a `FeaturesInsightsScenes.*` key (slice L6), so the Arabic page mirrors
 * the mock-ups too. Numbers, dates, weekdays and months go through the active-locale formatters.
 * Proper names (people, Atlas Hospitality, Northstar Studio, project titles, `Homepage Concept
 * v2`, object kinds such as TSK/DEL/DEC) stay in Latin on purpose.
 */

/** The scene keys arrive in the catalogs through the L6 i18n fragment; widened here once. */
type SceneKey = `FeaturesInsightsScenes.${string}`;

type Vars = Readonly<Record<string, string | number>>;

/** `s('key', { n: 3 })`: the scene string with `{n}` filled, numbers in the active locale. */
function useSceneCopy(): {
  s: (key: string, vars?: Vars) => string;
  fmt: DisplayFormatters;
} {
  const t = useT();
  const fmt = useDisplayFormatters();
  const s = useCallback(
    (key: string, vars?: Vars) => {
      let out = t(`FeaturesInsightsScenes.${key}` satisfies SceneKey as MessageKey);
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          out = out.replaceAll(`{${name}}`, typeof value === 'number' ? fmt.number(value) : value);
        }
      }
      return out;
    },
    [t, fmt],
  );
  return { s, fmt };
}

/** A calendar day at local noon, so the runtime timezone never shifts it. */
function day(fmt: DisplayFormatters, isoDate: string, options: Intl.DateTimeFormatOptions) {
  return fmt.day(`${isoDate}T12:00:00`, options);
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

function Scene({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-web-scene', 'tm-web-fi-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-scene__body tm-web-fi-card" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

function ObjectRef({ kind, title }: { kind: string; title: string }) {
  return (
    <span className="tm-web-fi-ref">
      <span className="tm-web-fi-ref__kind">{kind}</span>
      <span className="tm-web-fi-ref__title">{title}</span>
    </span>
  );
}

/* ── Hero: the Insights portfolio screen (product section 18/19) ──────────── */

const HEADLINES: readonly { value: number; unit?: 'hours'; of?: number; label: string }[] = [
  { value: 31, unit: 'hours', label: 'metricWait' },
  { value: 3, of: 46, label: 'metricBlocked' },
  { value: 2, of: 9, label: 'metricChanges' },
];

const PORTFOLIO: readonly {
  name: string;
  items: number;
  blocked: number;
  changes: number;
}[] = [
  { name: 'Atlas Website Relaunch', items: 46, blocked: 2, changes: 1 },
  { name: 'Northwind Brand Sprint', items: 28, blocked: 1, changes: 1 },
  { name: 'Cedar Clinic Booking App', items: 33, blocked: 0, changes: 0 },
];

export function PortfolioScene() {
  const t = useT();
  const { s, fmt } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--hero" label={t('PortfolioScene.label')}>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">{s('portfolioEyebrow')}</p>
        <Badge>{s('portfolioProjects', { n: 3 })}</Badge>
      </div>
      <p className="tm-web-fi-card__title">{s('portfolioTitle')}</p>
      <div className="tm-web-fi-headlines">
        {HEADLINES.map((h) => (
          <div key={h.label} className="tm-web-fi-metric">
            <span className="tm-web-fi-metric__value">
              {h.unit === 'hours' ? s('metricHours', { n: h.value }) : fmt.number(h.value)}
              {h.of ? (
                <span className="tm-web-fi-metric__of">{s('metricOf', { n: h.of })}</span>
              ) : null}
            </span>
            <span className="tm-web-fi-metric__label">{s(h.label)}</span>
          </div>
        ))}
      </div>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-fi-section-title">{s('exceptionsTitle')}</p>
        <span className="tm-web-fi-row__why">{s('exceptionsHint')}</span>
      </div>
      <div className="tm-web-fi-table" role="presentation">
        <div className="tm-web-fi-table__row tm-web-fi-table__row--head">
          <span>{s('colProject')}</span>
          <span className="tm-web-fi-table__num">{s('colItems')}</span>
          <span className="tm-web-fi-table__num">{s('colBlocked')}</span>
          <span className="tm-web-fi-table__num">{s('colChanges')}</span>
        </div>
        {PORTFOLIO.map((p) => (
          <div key={p.name} className="tm-web-fi-table__row">
            <span className="tm-web-fi-table__name">{p.name}</span>
            <span className="tm-web-fi-table__num">{fmt.number(p.items)}</span>
            <span
              className={cx(
                'tm-web-fi-table__num',
                p.blocked > 0 && 'tm-web-fi-table__num--danger',
              )}
            >
              {fmt.number(p.blocked)}
            </span>
            <span
              className={cx(
                'tm-web-fi-table__num',
                p.changes > 0 && 'tm-web-fi-table__num--warning',
              )}
            >
              {fmt.number(p.changes)}
            </span>
          </div>
        ))}
      </div>
    </Scene>
  );
}

/* ── Explainable health: a score drilled into its working ───────────────────── */

const FACTORS: readonly {
  name: string;
  weight: string;
  vars: Vars;
  /** A scene key, or a Latin object title shown as is. */
  detail: { key: string } | { title: string };
  tone: 'ok' | 'risk';
}[] = [
  {
    name: 'factorSchedule',
    weight: 'weightSchedule',
    vars: { late: 2, total: 9 },
    detail: { key: 'detailSchedule' },
    tone: 'risk',
  },
  {
    name: 'factorApprovals',
    weight: 'weightApprovals',
    vars: { n: 1 },
    detail: { title: 'Homepage Concept v2' },
    tone: 'risk',
  },
  {
    name: 'factorFreshness',
    weight: 'weightFreshness',
    vars: { n: 3 },
    detail: { key: 'detailFreshness' },
    tone: 'ok',
  },
  {
    name: 'factorScope',
    weight: 'weightScope',
    vars: { n: 1 },
    detail: { key: 'detailScope' },
    tone: 'ok',
  },
];

export function ScoreWorkingScene() {
  const t = useT();
  const { s } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--working" label={t('ScoreWorkingScene.label')}>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">{s('riskEyebrow')}</p>
        <Badge mono>{s('ruleSet')}</Badge>
      </div>
      <p className="tm-web-fi-card__title">{s('riskTitle')}</p>
      <p className="tm-web-fi-card__meta">{s('riskMeta')}</p>
      <ul className="tm-web-fi-factors">
        {FACTORS.map((f) => (
          <li key={f.name} className="tm-web-fi-factor">
            <span className="tm-web-fi-factor__name">{s(f.name)}</span>
            <span className="tm-web-fi-factor__track">
              <span
                className={cx(
                  'tm-web-fi-factor__fill',
                  f.tone === 'risk' && 'tm-web-fi-factor__fill--risk',
                )}
              />
            </span>
            <span className="tm-web-fi-factor__weight">{s(f.weight, f.vars)}</span>
            <span className="tm-web-fi-factor__link">
              <WebIcon name="link" size={14} />
              {'key' in f.detail ? s(f.detail.key) : f.detail.title}
            </span>
          </li>
        ))}
      </ul>
    </Scene>
  );
}

/* ── Portfolio: where the work sits, across projects ─────────────────────────── */

const STAGES: readonly { label: string; count: number; tone?: 'lime' | 'danger' }[] = [
  { label: 'stageInProgress', count: 38, tone: 'lime' },
  { label: 'stageInternalReview', count: 14 },
  { label: 'stageClientReview', count: 9 },
  { label: 'stageBlocked', count: 3, tone: 'danger' },
];

export function StagesScene() {
  const t = useT();
  const { s, fmt } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--stages" label={t('StagesScene.label')}>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-fi-section-title">{s('stagesTitle')}</p>
        <span className="tm-web-scene__mono">{s('stagesMeta')}</span>
      </div>
      <ul className="tm-web-fi-stages">
        {STAGES.map((stage) => (
          <li key={stage.label} className="tm-web-fi-stage">
            <span className="tm-web-fi-stage__label">{s(stage.label)}</span>
            <span className="tm-web-fi-factor__track">
              <span
                className={cx(
                  'tm-web-fi-stage__fill',
                  stage.tone && `tm-web-fi-stage__fill--${stage.tone}`,
                )}
                style={{ inlineSize: `${Math.round((stage.count / 38) * 100)}%` }}
              />
            </span>
            <span className="tm-web-fi-stage__count">{fmt.number(stage.count)}</span>
          </li>
        ))}
      </ul>
    </Scene>
  );
}

/* ── Approval cycle: time to a decision, per month ───────────────────────────── */

const CYCLE: readonly { month: string; days: number }[] = [
  { month: '2026-06-15', days: 2 },
  { month: '2026-07-15', days: 3 },
  { month: '2026-08-15', days: 4 },
  { month: '2026-09-15', days: 6 },
];

export function ApprovalCycleScene() {
  const t = useT();
  const { s, fmt } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--cycle" label={t('ApprovalCycleScene.label')}>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-fi-section-title">{s('cycleTitle')}</p>
        <span className="tm-web-scene__mono">{s('cycleMeta')}</span>
      </div>
      <div className="tm-web-fi-cycle">
        <span className="tm-web-fi-metric__value">{s('cycleValue', { n: 6 })}</span>
        <div className="tm-web-fi-bars">
          {CYCLE.map((bar, i) => (
            <span key={bar.month} className="tm-web-fi-bars__col">
              <span
                className={cx(
                  'tm-web-fi-bars__bar',
                  i === CYCLE.length - 1 && 'tm-web-fi-bars__bar--now',
                )}
                style={{ blockSize: `calc(var(--s3) * ${bar.days})` }}
              />
              <span className="tm-web-fi-bars__label">
                {day(fmt, bar.month, { month: 'short' })}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="tm-web-fi-row">
        <span className="tm-web-fi-row__text">
          <ObjectRef kind="DEL" title="Homepage Concept v2" />
          <span className="tm-web-fi-row__why">{s('cycleWaiting', { n: 6 })}</span>
        </span>
        <StateCapsule state="client">{s('stageClientReview')}</StateCapsule>
      </div>
    </Scene>
  );
}

/* ── Pulse: drafted for you, published by a person ──────────────────────────── */

export function PulseScene() {
  const t = useT();
  const { s, fmt } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--pulse" label={t('PulseScene.label')}>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">{s('pulseEyebrow', { n: 36 })}</p>
        <StatusDot tone="warning">{s('pulseDraft')}</StatusDot>
      </div>
      <p className="tm-web-fi-card__title">{s('pulseTitle')}</p>
      <p className="tm-web-fi-card__meta">{s('pulseFor')}</p>
      <div className="tm-web-fi-pulse__body">
        <div className="tm-web-fi-pulse__block">
          <p className="tm-web-fi-pulse__label">{s('pulseDoneLabel')}</p>
          <p>{s('pulseDoneText')}</p>
        </div>
        <div className="tm-web-fi-pulse__block">
          <p className="tm-web-fi-pulse__label">{s('pulseDecisionLabel')}</p>
          <p>{s('pulseDecisionText', { date: day(fmt, '2026-09-30', DAY_MONTH) })}</p>
        </div>
        <div className="tm-web-fi-pulse__block tm-web-fi-pulse__block--editing">
          <p className="tm-web-fi-pulse__label">{s('pulseNextLabel')}</p>
          <p>
            {s('pulseNextText')}
            <span className="tm-web-fi-caret" />
          </p>
        </div>
      </div>
      <div className="tm-web-fi-pulse__foot">
        <span className="tm-web-fi-pulse__by">
          <Avatar name="Maya Hassan" size="compact" decorative />
          <span>{s('pulseEditing', { name: 'Maya Hassan' })}</span>
        </span>
        <span className="tm-web-fi-actions">
          <Button tone="outline" size="feature">
            {s('pulsePreview')}
          </Button>
          <Button tone="ink" size="feature">
            {s('pulsePublish')}
          </Button>
        </span>
      </div>
    </Scene>
  );
}

/* ── Workload: commitments and constraints, never scores ────────────────────── */

/** Sunday to Thursday of week 36 (2026), shown as weekday names in the active locale. */
const DAYS = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'] as const;

/**
 * Commitments due per day for the team, and the constraints that explain them. No per-person
 * meter or figure: people appear only beside the constraint they declared.
 */
const DUE: readonly number[] = [3, 5, 4, 2, 2];

const CONSTRAINTS: readonly { name: string; text: string; tag: string }[] = [
  { name: 'Lina Samir', text: 'constraintLeave', tag: 'tagLeave' },
  { name: 'Karim Nabil', text: 'constraintShared', tag: 'tagShared' },
];

const AT_RISK: readonly { kind: string; title: string; why: string }[] = [
  { kind: 'TSK', title: 'bookingFlowConcepts', why: 'atRiskWhy' },
];

export function WorkloadScene() {
  const t = useT();
  const { s, fmt } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--workload" label={t('WorkloadScene.label')}>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">{s('workloadEyebrow', { n: 36 })}</p>
        <Badge>{s('noScores')}</Badge>
      </div>
      <p className="tm-web-fi-card__title">{s('workloadTitle', { n: 16 })}</p>
      <div className="tm-web-fi-days">
        {DAYS.map((d, i) => (
          <span key={d} className="tm-web-fi-day">
            <span className="tm-web-fi-day__count">{fmt.number(DUE[i] ?? 0)}</span>
            <span className="tm-web-fi-bars__label">{day(fmt, d, { weekday: 'short' })}</span>
          </span>
        ))}
      </div>
      <p className="tm-web-fi-pulse__label">{s('constraintsLabel')}</p>
      <ul className="tm-web-fi-list">
        {CONSTRAINTS.map((c) => (
          <li key={c.name} className="tm-web-fi-person">
            <Avatar name={c.name} size="compact" decorative />
            <span className="tm-web-fi-person__text">
              <span className="tm-web-fi-person__name">{c.name}</span>
              <span className="tm-web-fi-row__why">{s(c.text)}</span>
            </span>
            <Badge>{s(c.tag)}</Badge>
          </li>
        ))}
        {AT_RISK.map((r) => (
          <li key={r.title} className="tm-web-fi-row">
            <span className="tm-web-fi-row__text">
              <ObjectRef kind={r.kind} title={s(r.title)} />
              <span className="tm-web-fi-row__why">{s(r.why)}</span>
            </span>
            <StateCapsule state="waiting">{s('replan')}</StateCapsule>
          </li>
        ))}
      </ul>
    </Scene>
  );
}

/* ── Automations: a rule, its identity and a dry run ────────────────────────── */

export function AutomationScene() {
  const t = useT();
  const { s } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--automation" label={t('AutomationScene.label')}>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">{s('autoEyebrow')}</p>
        <StatusDot tone="neutral">{s('autoOff')}</StatusDot>
      </div>
      <p className="tm-web-fi-card__title">{s('autoTitle')}</p>
      <div className="tm-web-fi-rule">
        <div className="tm-web-fi-rule__step">
          <span className="tm-web-fi-rule__key">{s('autoWhen')}</span>
          <span>{s('autoWhenText', { n: 3 })}</span>
        </div>
        <div className="tm-web-fi-rule__step">
          <span className="tm-web-fi-rule__key">{s('autoThen')}</span>
          <span>{s('autoThenText')}</span>
        </div>
        <div className="tm-web-fi-rule__step">
          <span className="tm-web-fi-rule__key">{s('autoActsAs')}</span>
          <span className="tm-web-fi-rule__who">
            <WebIcon name="id" size={14} />
            {s('autoIdentity')}
          </span>
        </div>
      </div>
      <div className="tm-web-fi-dry">
        <p className="tm-web-fi-pulse__label">{s('dryLabel')}</p>
        <p className="tm-web-fi-dry__line">
          {s('dryWouldRemind')} <strong>Salma Riad</strong> {s('dryAbout')}{' '}
          <strong>Homepage Concept v2</strong>
        </p>
        <p className="tm-web-fi-row__why">{s('dryMeta', { n: 1, projects: 3 })}</p>
      </div>
      <div className="tm-web-fi-pulse__foot">
        <span className="tm-web-fi-row__why">{s('autoAudit')}</span>
        <span className="tm-web-fi-actions">
          <Button tone="outline" size="feature">
            {s('runAgain')}
          </Button>
          <Button tone="ink" size="feature">
            {s('switchOn')}
          </Button>
        </span>
      </div>
    </Scene>
  );
}

/* ── AI assistant: answers with sources, no actions ─────────────────────────── */

const SOURCES: readonly {
  n: number;
  kind: string;
  /** A scene key, or a Latin object title shown as is. */
  title: { key: string } | { latin: string };
  meta: string;
  vars?: Vars;
}[] = [
  { n: 1, kind: 'TSK', title: { key: 'sourceConcepts' }, meta: 'sourceConceptsMeta' },
  { n: 2, kind: 'DEC', title: { key: 'sourceApi' }, meta: 'sourceApiMeta' },
  {
    n: 3,
    kind: 'DEL',
    title: { latin: 'Homepage Concept v2' },
    meta: 'sourceConceptMeta',
    vars: { n: 6 },
  },
];

export function AssistantScene() {
  const t = useT();
  const { s, fmt } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--assistant" label={t('AssistantScene.label')}>
      <div className="tm-web-fi-ask">
        <WebIcon name="search" size={14} />
        <span className="tm-web-fi-ask__text">{s('askText')}</span>
      </div>
      <div className="tm-web-fi-answer">
        <p className="tm-web-scene__mono">{s('answerMeta', { n: 3 })}</p>
        <p className="tm-web-fi-answer__text">
          {s('answerPart1')}
          <span className="tm-web-fi-cite">{fmt.number(1)}</span>
          {s('answerPart2')}
          <span className="tm-web-fi-cite">{fmt.number(2)}</span>
          {s('answerPart3')}
          <span className="tm-web-fi-cite">{fmt.number(3)}</span>
          {s('answerPart4')}
        </p>
      </div>
      <ul className="tm-web-fi-list">
        {SOURCES.map((source) => (
          <li key={source.n} className="tm-web-fi-row">
            <span className="tm-web-fi-row__text">
              <span className="tm-web-fi-source">
                <span className="tm-web-fi-cite">{fmt.number(source.n)}</span>
                <ObjectRef
                  kind={source.kind}
                  title={'key' in source.title ? s(source.title.key) : source.title.latin}
                />
              </span>
              <span className="tm-web-fi-row__why">{s(source.meta, source.vars)}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="tm-web-fi-limits">
        <WebIcon name="lock" size={14} />
        {s('assistantLimits')}
      </p>
    </Scene>
  );
}

/* ── CTA band crop: project health with its drivers ─────────────────────────── */

const DRIVERS: readonly {
  kind: string;
  /** A scene key, or a Latin object title shown as is. */
  title: { key: string } | { latin: string };
  state: CapsuleState;
  tag: string;
}[] = [
  {
    kind: 'DEL',
    title: { latin: 'Homepage Concept v2' },
    state: 'client',
    tag: 'stageClientReview',
  },
  { kind: 'TSK', title: { key: 'bookingFlowConcepts' }, state: 'blocked', tag: 'stageBlocked' },
];

export function HealthCropScene() {
  const t = useT();
  const { s, fmt } = useSceneCopy();
  return (
    <Scene className="tm-web-fi-scene--crop" label={t('HealthCropScene.label')}>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">{s('healthEyebrow')}</p>
        <StateCapsule state="waiting">{s('healthWatch')}</StateCapsule>
      </div>
      <div>
        <p className="tm-web-fi-metric__label">{s('forecastLabel')}</p>
        <p className="tm-web-fi-metric__value">{day(fmt, '2026-10-04', DAY_MONTH)}</p>
        <p className="tm-web-fi-card__meta">
          {s('forecastCommitted', { date: day(fmt, '2026-09-30', DAY_MONTH), n: 4 })}
        </p>
      </div>
      <ul className="tm-web-fi-list">
        {DRIVERS.map((d) => (
          <li key={d.tag} className="tm-web-fi-row tm-web-fi-row--inline">
            <ObjectRef kind={d.kind} title={'key' in d.title ? s(d.title.key) : d.title.latin} />
            <StateCapsule state={d.state}>{s(d.tag)}</StateCapsule>
          </li>
        ))}
      </ul>
    </Scene>
  );
}
