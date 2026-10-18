'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, StatusDot, type CapsuleState } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Mini product scenes for Features · Insights & automations (WEB-06). Each one is composed from
 * packages/ui parts (StateCapsule, StatusDot, Badge, Avatar, Button) and token-only classes in
 * `features-insights.css`. Like the shared scenes, the body is `inert` and hidden from assistive
 * tech; `label` gives one sentence of alternative text.
 */
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

const HEADLINES: readonly { value: string; badge?: string; label: string }[] = [
  { value: '31h', label: 'mean wait for an approval decision' },
  { value: '3', badge: 'of 46', label: 'work items blocked right now' },
  { value: '2', badge: 'of 9', label: 'approvals sent back for changes' },
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
  return (
    <Scene
      className="tm-web-fi-scene--hero"
      label="The Insights portfolio: mean approval wait, blocked work and returned approvals across three client projects, with the exceptions listed first."
    >
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">Insights · Client delivery</p>
        <Badge>3 projects</Badge>
      </div>
      <p className="tm-web-fi-card__title">Where delivery is losing time</p>
      <div className="tm-web-fi-headlines">
        {HEADLINES.map((h) => (
          <div key={h.label} className="tm-web-fi-metric">
            <span className="tm-web-fi-metric__value">
              {h.value}
              {h.badge ? <span className="tm-web-fi-metric__of">{h.badge}</span> : null}
            </span>
            <span className="tm-web-fi-metric__label">{h.label}</span>
          </div>
        ))}
      </div>
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-fi-section-title">Exceptions, not averages</p>
        <span className="tm-web-fi-row__why">every row opens its evidence</span>
      </div>
      <div className="tm-web-fi-table" role="presentation">
        <div className="tm-web-fi-table__row tm-web-fi-table__row--head">
          <span>Project</span>
          <span className="tm-web-fi-table__num">Items</span>
          <span className="tm-web-fi-table__num">Blocked</span>
          <span className="tm-web-fi-table__num">Changes</span>
        </div>
        {PORTFOLIO.map((p) => (
          <div key={p.name} className="tm-web-fi-table__row">
            <span className="tm-web-fi-table__name">{p.name}</span>
            <span className="tm-web-fi-table__num">{p.items}</span>
            <span
              className={cx(
                'tm-web-fi-table__num',
                p.blocked > 0 && 'tm-web-fi-table__num--danger',
              )}
            >
              {p.blocked}
            </span>
            <span
              className={cx(
                'tm-web-fi-table__num',
                p.changes > 0 && 'tm-web-fi-table__num--warning',
              )}
            >
              {p.changes}
            </span>
          </div>
        ))}
      </div>
    </Scene>
  );
}

/* ── Explainable health: a score drilled into its working ───────────────────── */

const FACTORS: readonly { name: string; weight: string; detail: string; tone: 'ok' | 'risk' }[] = [
  {
    name: 'Schedule',
    weight: '2 of 9 milestones late',
    detail: 'Homepage direction',
    tone: 'risk',
  },
  { name: 'Approvals', weight: '1 open past target', detail: 'Homepage Concept v2', tone: 'risk' },
  { name: 'Freshness', weight: 'Updated 3 days ago', detail: 'Booking widget QA', tone: 'ok' },
  { name: 'Scope', weight: '1 request not committed', detail: 'Arabic booking FAQ', tone: 'ok' },
];

export function ScoreWorkingScene() {
  return (
    <Scene
      className="tm-web-fi-scene--working"
      label="A risk score opened to show its working: schedule, approvals, freshness and scope, each linked to the item behind it."
    >
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">Risk · Atlas Website Relaunch</p>
        <Badge mono>Rule set v3</Badge>
      </div>
      <p className="tm-web-fi-card__title">Medium risk — here is why</p>
      <p className="tm-web-fi-card__meta">Each factor links to the work that set it.</p>
      <ul className="tm-web-fi-factors">
        {FACTORS.map((f) => (
          <li key={f.name} className="tm-web-fi-factor">
            <span className="tm-web-fi-factor__name">{f.name}</span>
            <span className="tm-web-fi-factor__track">
              <span
                className={cx(
                  'tm-web-fi-factor__fill',
                  f.tone === 'risk' && 'tm-web-fi-factor__fill--risk',
                )}
              />
            </span>
            <span className="tm-web-fi-factor__weight">{f.weight}</span>
            <span className="tm-web-fi-factor__link">
              <WebIcon name="link" size={14} />
              {f.detail}
            </span>
          </li>
        ))}
      </ul>
    </Scene>
  );
}

/* ── Portfolio: where the work sits, across projects ─────────────────────────── */

const STAGES: readonly { label: string; count: number; tone?: 'lime' | 'danger' }[] = [
  { label: 'In progress', count: 38, tone: 'lime' },
  { label: 'Internal review', count: 14 },
  { label: 'Client review', count: 9 },
  { label: 'Blocked', count: 3, tone: 'danger' },
];

export function StagesScene() {
  return (
    <Scene
      className="tm-web-fi-scene--stages"
      label="Work items by stage across all projects: 38 in progress, 14 in internal review, 9 in client review and 3 blocked."
    >
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-fi-section-title">Where the work sits</p>
        <span className="tm-web-scene__mono">Items · all projects</span>
      </div>
      <ul className="tm-web-fi-stages">
        {STAGES.map((s) => (
          <li key={s.label} className="tm-web-fi-stage">
            <span className="tm-web-fi-stage__label">{s.label}</span>
            <span className="tm-web-fi-factor__track">
              <span
                className={cx(
                  'tm-web-fi-stage__fill',
                  s.tone && `tm-web-fi-stage__fill--${s.tone}`,
                )}
                style={{ inlineSize: `${Math.round((s.count / 38) * 100)}%` }}
              />
            </span>
            <span className="tm-web-fi-stage__count">{s.count}</span>
          </li>
        ))}
      </ul>
    </Scene>
  );
}

/* ── Approval cycle: time to a decision, per month ───────────────────────────── */

const CYCLE: readonly { label: string; days: number }[] = [
  { label: 'Jun', days: 2 },
  { label: 'Jul', days: 3 },
  { label: 'Aug', days: 4 },
  { label: 'Sep', days: 6 },
];

export function ApprovalCycleScene() {
  return (
    <Scene
      className="tm-web-fi-scene--cycle"
      label="Approval cycle for Atlas Website Relaunch: six days to a client decision in September, up from two in June, driven by Homepage Concept v2."
    >
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-fi-section-title">Time to a client decision</p>
        <span className="tm-web-scene__mono">Atlas · days</span>
      </div>
      <div className="tm-web-fi-cycle">
        <span className="tm-web-fi-metric__value">6 days</span>
        <div className="tm-web-fi-bars">
          {CYCLE.map((bar, i) => (
            <span key={bar.label} className="tm-web-fi-bars__col">
              <span
                className={cx(
                  'tm-web-fi-bars__bar',
                  i === CYCLE.length - 1 && 'tm-web-fi-bars__bar--now',
                )}
                style={{ blockSize: `calc(var(--s3) * ${bar.days})` }}
              />
              <span className="tm-web-fi-bars__label">{bar.label}</span>
            </span>
          ))}
        </div>
      </div>
      <div className="tm-web-fi-row">
        <span className="tm-web-fi-row__text">
          <ObjectRef kind="DEL" title="Homepage Concept v2" />
          <span className="tm-web-fi-row__why">Waiting 6 days</span>
        </span>
        <StateCapsule state="client">Client review</StateCapsule>
      </div>
    </Scene>
  );
}

/* ── Pulse: drafted for you, published by a person ──────────────────────────── */

export function PulseScene() {
  return (
    <Scene
      className="tm-web-fi-scene--pulse"
      label="A weekly client update drafted by Pulse from current work, being edited by Maya Hassan before she publishes it."
    >
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">Pulse · Week 36</p>
        <StatusDot tone="warning">Draft — not published</StatusDot>
      </div>
      <p className="tm-web-fi-card__title">Atlas Website Relaunch — weekly update</p>
      <p className="tm-web-fi-card__meta">For Atlas Hospitality · Salma Riad, Youssef Kamal</p>
      <div className="tm-web-fi-pulse__body">
        <div className="tm-web-fi-pulse__block">
          <p className="tm-web-fi-pulse__label">Done this week</p>
          <p>Room grid content and the booking widget QA are complete.</p>
        </div>
        <div className="tm-web-fi-pulse__block">
          <p className="tm-web-fi-pulse__label">Needs your decision</p>
          <p>
            Homepage Concept v2 is waiting on your review. Launch holds at 30 Sep if we hear back by
            Friday.
          </p>
        </div>
        <div className="tm-web-fi-pulse__block tm-web-fi-pulse__block--editing">
          <p className="tm-web-fi-pulse__label">Next</p>
          <p>
            Mobile booking flow concepts
            <span className="tm-web-fi-caret" />
          </p>
        </div>
      </div>
      <div className="tm-web-fi-pulse__foot">
        <span className="tm-web-fi-pulse__by">
          <Avatar name="Maya Hassan" size="compact" decorative />
          <span>Maya Hassan is editing</span>
        </span>
        <span className="tm-web-fi-actions">
          <Button tone="outline" size="feature">
            Preview
          </Button>
          <Button tone="ink" size="feature">
            Publish to client
          </Button>
        </span>
      </div>
    </Scene>
  );
}

/* ── Workload: commitments and constraints, never scores ────────────────────── */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu'] as const;

/**
 * Commitments due per day for the team, and the constraints that explain them. No per-person
 * meter or figure: people appear only beside the constraint they declared.
 */
const DUE: readonly number[] = [3, 5, 4, 2, 2];

const CONSTRAINTS: readonly { name: string; text: string; tag: string }[] = [
  { name: 'Lina Samir', text: 'On leave Thursday', tag: 'Leave' },
  { name: 'Karim Nabil', text: 'Shared with Brand sprint until Tue', tag: 'Shared' },
];

const AT_RISK: readonly { kind: string; title: string; why: string }[] = [
  { kind: 'TSK', title: 'Booking flow concepts', why: 'Due Thu · owner on leave' },
];

export function WorkloadScene() {
  return (
    <Scene
      className="tm-web-fi-scene--workload"
      label="Team workload for week 36 shown as commitments due each day and the constraints behind them, with no score for any person."
    >
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">Workload · Design team · Week 36</p>
        <Badge>No scores</Badge>
      </div>
      <p className="tm-web-fi-card__title">16 commitments due this week</p>
      <div className="tm-web-fi-days">
        {DAYS.map((d, i) => (
          <span key={d} className="tm-web-fi-day">
            <span className="tm-web-fi-day__count">{DUE[i]}</span>
            <span className="tm-web-fi-bars__label">{d}</span>
          </span>
        ))}
      </div>
      <p className="tm-web-fi-pulse__label">Constraints</p>
      <ul className="tm-web-fi-list">
        {CONSTRAINTS.map((c) => (
          <li key={c.name} className="tm-web-fi-person">
            <Avatar name={c.name} size="compact" decorative />
            <span className="tm-web-fi-person__text">
              <span className="tm-web-fi-person__name">{c.name}</span>
              <span className="tm-web-fi-row__why">{c.text}</span>
            </span>
            <Badge>{c.tag}</Badge>
          </li>
        ))}
        {AT_RISK.map((r) => (
          <li key={r.title} className="tm-web-fi-row">
            <span className="tm-web-fi-row__text">
              <ObjectRef kind={r.kind} title={r.title} />
              <span className="tm-web-fi-row__why">{r.why}</span>
            </span>
            <StateCapsule state="waiting">Re-plan</StateCapsule>
          </li>
        ))}
      </ul>
    </Scene>
  );
}

/* ── Automations: a rule, its identity and a dry run ────────────────────────── */

export function AutomationScene() {
  return (
    <Scene
      className="tm-web-fi-scene--automation"
      label="An automation that reminds a client reviewer after three days, showing which identity acts and a dry-run result before it is switched on."
    >
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">Automation · Template</p>
        <StatusDot tone="neutral">Off</StatusDot>
      </div>
      <p className="tm-web-fi-card__title">Remind a reviewer</p>
      <div className="tm-web-fi-rule">
        <div className="tm-web-fi-rule__step">
          <span className="tm-web-fi-rule__key">When</span>
          <span>A deliverable waits in client review for 3 days</span>
        </div>
        <div className="tm-web-fi-rule__step">
          <span className="tm-web-fi-rule__key">Then</span>
          <span>Remind the reviewer in the client channel</span>
        </div>
        <div className="tm-web-fi-rule__step">
          <span className="tm-web-fi-rule__key">Acts as</span>
          <span className="tm-web-fi-rule__who">
            <WebIcon name="id" size={14} />
            Northstar Studio automation · not a person
          </span>
        </div>
      </div>
      <div className="tm-web-fi-dry">
        <p className="tm-web-fi-pulse__label">Dry run · nothing was sent</p>
        <p className="tm-web-fi-dry__line">
          Would remind <strong>Salma Riad</strong> about <strong>Homepage Concept v2</strong>
        </p>
        <p className="tm-web-fi-row__why">1 match in 3 projects · checked just now</p>
      </div>
      <div className="tm-web-fi-pulse__foot">
        <span className="tm-web-fi-row__why">Switching on is logged in the audit trail</span>
        <span className="tm-web-fi-actions">
          <Button tone="outline" size="feature">
            Run again
          </Button>
          <Button tone="ink" size="feature">
            Switch on
          </Button>
        </span>
      </div>
    </Scene>
  );
}

/* ── AI assistant: answers with sources, no actions ─────────────────────────── */

const SOURCES: readonly { n: number; kind: string; title: string; meta: string }[] = [
  {
    n: 1,
    kind: 'TSK',
    title: 'Prepare mobile booking flow concepts',
    meta: 'Blocked · Lina Samir',
  },
  { n: 2, kind: 'DEC', title: 'Booking API answer due from Atlas IT', meta: 'Decision · open' },
  { n: 3, kind: 'DEL', title: 'Homepage Concept v2', meta: 'Client review · 6 days' },
];

export function AssistantScene() {
  return (
    <Scene
      className="tm-web-fi-scene--assistant"
      label="The assistant answers what is blocking the Atlas launch, citing three work items, and states that it cannot publish, approve, invite or delete."
    >
      <div className="tm-web-fi-ask">
        <WebIcon name="search" size={14} />
        <span className="tm-web-fi-ask__text">What is holding up the Atlas launch?</span>
      </div>
      <div className="tm-web-fi-answer">
        <p className="tm-web-scene__mono">Answer · 3 sources</p>
        <p className="tm-web-fi-answer__text">
          Two things. The mobile booking concepts are blocked
          <span className="tm-web-fi-cite">1</span> until Atlas IT answers the booking API question
          <span className="tm-web-fi-cite">2</span>, and Homepage Concept v2 has been in client
          review for six days<span className="tm-web-fi-cite">3</span>.
        </p>
      </div>
      <ul className="tm-web-fi-list">
        {SOURCES.map((s) => (
          <li key={s.n} className="tm-web-fi-row">
            <span className="tm-web-fi-row__text">
              <span className="tm-web-fi-source">
                <span className="tm-web-fi-cite">{s.n}</span>
                <ObjectRef kind={s.kind} title={s.title} />
              </span>
              <span className="tm-web-fi-row__why">{s.meta}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="tm-web-fi-limits">
        <WebIcon name="lock" size={14} />
        Read-only · cannot publish, approve, invite or delete
      </p>
    </Scene>
  );
}

/* ── CTA band crop: project health with its drivers ─────────────────────────── */

const DRIVERS: readonly { kind: string; title: string; state: CapsuleState; tag: string }[] = [
  { kind: 'DEL', title: 'Homepage Concept v2', state: 'client', tag: 'Client review' },
  { kind: 'TSK', title: 'Booking flow concepts', state: 'blocked', tag: 'Blocked' },
];

export function HealthCropScene() {
  return (
    <Scene
      className="tm-web-fi-scene--crop"
      label="Project health for Atlas Website Relaunch: Watch, the launch forecast moved four days, with the two work items behind it."
    >
      <div className="tm-web-fi-scene__head">
        <p className="tm-web-scene__mono">Project health · Atlas</p>
        <StateCapsule state="waiting">Watch</StateCapsule>
      </div>
      <div>
        <p className="tm-web-fi-metric__label">Launch forecast</p>
        <p className="tm-web-fi-metric__value">4 Oct</p>
        <p className="tm-web-fi-card__meta">Committed 30 Sep · +4 days</p>
      </div>
      <ul className="tm-web-fi-list">
        {DRIVERS.map((d) => (
          <li key={d.title} className="tm-web-fi-row tm-web-fi-row--inline">
            <ObjectRef kind={d.kind} title={d.title} />
            <StateCapsule state={d.state}>{d.tag}</StateCapsule>
          </li>
        ))}
      </ul>
    </Scene>
  );
}
