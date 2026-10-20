'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import { WebIcon, type WebIconName } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Mini product scenes for Features · Work, requests & projects (Figma 03-features-work). Each
 * is real TManage UI composed from packages/ui parts (StateCapsule, Badge, Avatar, Button) and
 * Limeframe tokens, drawn at product size and scaled down by the page CSS — the "clone at
 * 0.5–0.75" rule of SITE-SPEC §0. Scenes are illustrations: the body is `inert` and hidden from
 * assistive tech, and `label` is the one-sentence alternative text.
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
    <figure className={cx('tm-fw-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-fw-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

/**
 * Mono/Caption. The uppercase, tracked form takes the website's eyebrow style, so its tracking
 * comes from the shared layer rather than a value typed here; `caps={false}` is the plain mono
 * line the product uses for dates and counts.
 */
const Mono = ({
  children,
  className,
  caps = true,
}: {
  children: ReactNode;
  className?: string | undefined;
  caps?: boolean;
}) => <span className={cx(caps && 'tm-web-eyebrow', 'tm-fw-mono', className)}>{children}</span>;

/** Truncating text for dense rows: one line, ellipsis at the end. */
const Clip = ({ children }: { children: ReactNode }) => (
  <span className="tm-fw-clip">{children}</span>
);

/** A small initials disc for dense rows, where the 32 px Avatar would crowd the line. */
const Initials = ({ name, tone = 'paper' }: { name: string; tone?: 'paper' | 'ink' }) => (
  <span className={cx('tm-fw-initials', tone === 'ink' && 'tm-fw-initials--ink')}>{name}</span>
);

/* ── Hero: the Work board inside the app shell ───────────────────────────────── */

const RAIL: readonly { icon: WebIconName; label: string; on?: boolean }[] = [
  { icon: 'pulse', label: 'Home' },
  { icon: 'mail', label: 'Inbox' },
  { icon: 'chat', label: 'Chat' },
  { icon: 'work', label: 'Work', on: true },
  { icon: 'doc', label: 'Docs' },
  { icon: 'flag', label: 'Plan' },
  { icon: 'portal', label: 'Clients' },
  { icon: 'chart', label: 'Insights' },
  { icon: 'shield', label: 'Control' },
];

interface BoardCardData {
  id: string;
  title: string;
  meta?: ReactNode;
  capsule?: { state: CapsuleState; label: string };
  selected?: boolean;
}

function BoardCard({ id, title, meta, capsule, selected }: BoardCardData) {
  return (
    <div className={cx('tm-fw-card', selected && 'tm-fw-card--selected')}>
      <div className="tm-fw-card__top">
        <Mono>{id}</Mono>
        <span className="tm-fw-card__orb">
          <span />
        </span>
      </div>
      <p className="tm-fw-card__title">{title}</p>
      {capsule ? <StateCapsule state={capsule.state}>{capsule.label}</StateCapsule> : null}
      {meta ? (
        <Mono caps={false} className="tm-fw-card__meta">
          {meta}
        </Mono>
      ) : null}
    </div>
  );
}

function BoardColumn({
  title,
  count,
  flag,
  cards,
}: {
  title: string;
  count: string;
  flag?: string;
  cards: readonly BoardCardData[];
}) {
  return (
    <div className="tm-fw-board__col">
      <p className="tm-fw-board__col-head">
        <span>{title}</span>
        <Mono>{count}</Mono>
        {flag ? <span className="tm-web-eyebrow tm-fw-flag">{flag}</span> : null}
      </p>
      {cards.map((card) => (
        <BoardCard key={card.title} {...card} />
      ))}
    </div>
  );
}

const NOT_STARTED: readonly BoardCardData[] = [
  {
    id: 'TSK · NF',
    title: 'Booking CTA microcopy — EN and AR',
    meta: 'committed 20 Aug',
  },
  {
    id: 'TSK · Unowned',
    title: 'Accessibility pass on booking flow',
    capsule: { state: 'waiting', label: 'No owner' },
  },
];

const IN_PROGRESS: readonly BoardCardData[] = [
  {
    id: 'TSK · LS',
    title: 'Prepare mobile booking flow concepts',
    capsule: { state: 'blocked', label: 'Blocked: brand assets' },
    meta: (
      <>
        committed 20 Aug · <span className="tm-fw-late">forecast 25 Aug</span>
      </>
    ),
    selected: true,
  },
  {
    id: 'TSK · NF',
    title: 'Migrate Arabic booking FAQ copy',
    meta: (
      <>
        committed 1 Sep · <span className="tm-fw-late">forecast 8 Sep</span>
      </>
    ),
  },
];

const IN_REVIEW: readonly BoardCardData[] = [
  {
    id: 'DEC · MH',
    title: 'Homepage direction — decision record',
    meta: '2 of 3 reviewers done',
  },
];

export function WorkBoardScene() {
  const t = useT();
  return (
    <Scene label={t('WorkBoardScene.label')} className="tm-fw-scene--board">
      <div className="tm-fw-shell">
        <nav className="tm-fw-rail">
          <span className="tm-fw-rail__logo">
            <span />
          </span>
          {RAIL.map((item) => (
            <span key={item.label} className={cx('tm-fw-rail__item', item.on && 'is-on')}>
              <span className="tm-fw-rail__orb">
                <WebIcon name={item.icon} size={14} />
              </span>
              <span className="tm-fw-rail__label">{item.label}</span>
            </span>
          ))}
          <span className="tm-fw-rail__me">OA</span>
        </nav>
        <div className="tm-fw-board">
          <Mono>Atlas Website Relaunch · Workflow “Delivery with client review”</Mono>
          <div className="tm-fw-board__head">
            <p className="tm-web-header__title tm-fw-board__title">Board</p>
            <span className="tm-fw-seg">
              <span>List</span>
              <span className="is-on">Board</span>
              <span>Timeline</span>
            </span>
          </div>
          <p className="tm-fw-toast">
            <span className="tm-fw-toast__dot" />
            Moving “Prepare mobile booking flow concepts” — column 3 of 12
          </p>
          <div className="tm-fw-board__cols">
            <BoardColumn title="Not started" count="10" cards={NOT_STARTED} />
            <BoardColumn
              title="In progress"
              count="9 / WIP 6"
              flag="At limit"
              cards={IN_PROGRESS}
            />
            <BoardColumn title="Internal review" count="2" cards={IN_REVIEW} />
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Requests: a client request waiting with a manager ───────────────────────── */

export function RequestScene() {
  const t = useT();
  return (
    <Scene label={t('RequestScene.label')} className="tm-fw-scene--request">
      <div className="tm-fw-request">
        <div className="tm-fw-request__card">
          <p className="tm-fw-request__ids">
            <Badge tone="client">Client request</Badge>
            <Mono>REQ-64 · Atlas Hospitality</Mono>
          </p>
          <p className="tm-fw-request__title">Add Arabic booking FAQ before launch</p>
          <p className="tm-fw-request__body">
            From Salma Riad · Reason: guests ask about booking changes in Arabic. 1 file attached.
          </p>
          <p className="tm-fw-request__state">
            <StateCapsule state="waiting">Waiting with a manager</StateCapsule>
          </p>
          <Mono className="tm-fw-request__date">Desired 3 Sep · not committed</Mono>
          <div className="tm-fw-request__actions">
            <Button tone="ink" size="feature">
              Accept
            </Button>
            <Button tone="outline" size="feature">
              Defer
            </Button>
            <Button tone="text" size="feature">
              Decline
            </Button>
          </div>
        </div>
        <div className="tm-fw-reply">
          <div className="tm-fw-reply__who">
            <Avatar name="Salma Riad" audience="client" size="compact" decorative />
            <span>
              <span className="tm-fw-reply__name">Salma Riad</span>
              <Mono>Client portal · Reply</Mono>
            </span>
          </div>
          <p className="tm-fw-reply__text">
            Here is the Arabic copy for the FAQ. Can it go live with the booking page?
          </p>
          <Badge mono>faq-arabic-v2.docx</Badge>
        </div>
      </div>
    </Scene>
  );
}

/* ── Work items: one work item, every detail ─────────────────────────────────── */

const SUBTASKS: readonly { title: string; done?: boolean; blocked?: boolean; who?: string }[] = [
  { title: 'Audit the current booking steps', done: true, who: 'LS' },
  { title: 'Collect guest booking research', done: true, who: 'NF' },
  { title: 'Draft three directions', blocked: true, who: 'LS' },
  { title: 'Arabic layout check', who: 'KN' },
];

export function WorkItemScene() {
  const t = useT();
  return (
    <Scene label={t('WorkItemScene.label')} className="tm-fw-scene--item">
      <div className="tm-fw-item">
        <div className="tm-fw-item__main">
          <div className="tm-fw-panel">
            <p className="tm-fw-item__crumb">
              <span className="tm-fw-back">
                <WebIcon name="arrow-right" size={12} className="tm-fw-back__icon" />
                Delivery risk
              </span>
              <Mono>TSK-1042 · Atlas Website Relaunch</Mono>
            </p>
            <p className="tm-section-head__title tm-fw-item__title">
              Prepare mobile booking flow concepts
            </p>
            <p className="tm-fw-item__chips">
              <StateCapsule state="blocked">Blocked</StateCapsule>
              <span className="tm-fw-pill">
                <Initials name="LS" tone="ink" />
                Lina Samir
              </span>
              <span className="tm-fw-pill">
                <span className="tm-fw-pill__ring" />
                Internal
              </span>
            </p>
            <div className="tm-fw-next">
              <span className="tm-fw-next__orb">
                <WebIcon name="play" size={12} />
              </span>
              <span className="tm-fw-next__text">
                <span className="tm-fw-next__title">Resolve the brand-asset blocker</span>
                <span className="tm-fw-next__why">
                  Why now — this is the only thing between the task and its 20 Aug commitment.
                </span>
              </span>
              <span className="tm-fw-next__go">
                <WebIcon name="arrow-right" size={12} />
              </span>
            </div>
            <dl className="tm-fw-facts">
              <div>
                <dt className="tm-web-eyebrow">Committed</dt>
                <dd>20 Aug 2026</dd>
              </div>
              <div>
                <dt className="tm-web-eyebrow">Forecast</dt>
                <dd className="tm-fw-late">25 Aug 2026</dd>
              </div>
              <div>
                <dt className="tm-web-eyebrow">Milestone</dt>
                <dd>Homepage direction</dd>
              </div>
              <div>
                <dt className="tm-web-eyebrow">Source</dt>
                <dd>#atlas-relaunch</dd>
              </div>
            </dl>
            <p className="tm-fw-item__desc">
              Three concept directions for the mobile booking flow, covering the room selection
              step, the date picker and the confirmation screen. Arabic layout is in scope.
            </p>
          </div>
          <div className="tm-fw-panel tm-fw-item__subtasks">
            <p className="tm-fw-subtasks__head">
              <span className="tm-fw-subtasks__title">Subtasks</span>
              <Mono>2 of 4 done · progress is not the parent’s progress</Mono>
            </p>
            <ul className="tm-fw-subtasks">
              {SUBTASKS.map((task) => (
                <li
                  key={task.title}
                  className={cx(
                    'tm-fw-subtask',
                    task.done && 'is-done',
                    task.blocked && 'is-blocked',
                  )}
                >
                  <span className="tm-fw-box">
                    {task.done ? <WebIcon name="check" size={12} /> : null}
                  </span>
                  <span className="tm-fw-subtask__title">{task.title}</span>
                  {task.blocked ? <Mono className="tm-fw-late">Blocked</Mono> : null}
                  {task.who ? (
                    <Initials name={task.who} tone={task.done ? 'ink' : 'paper'} />
                  ) : null}
                </li>
              ))}
              <li className="tm-fw-subtask tm-fw-subtask--add">
                <span className="tm-fw-box tm-fw-box--ghost" />
                <span className="tm-fw-subtask__title">Add a subtask</span>
                <Mono>↑↓ reorder</Mono>
              </li>
            </ul>
          </div>
        </div>
        <div className="tm-fw-item__side">
          <div className="tm-fw-panel tm-fw-item__story">
            <Mono>Work story</Mono>
            <ol className="tm-fw-story">
              <li>
                <Mono>Requested · 14 Aug · Salma</Mono>
                <span>Asked in the client channel</span>
              </li>
              <li>
                <Mono>Committed · 14 Aug · Omar</Mono>
                <span>20 Aug, owner Lina</span>
              </li>
              <li className="is-now">
                <Mono>Now · blocked 3h</Mono>
                <span>Brand assets have not arrived</span>
              </li>
            </ol>
          </div>
          <div className="tm-fw-deps">
            <Mono>WK-12 · Dependencies</Mono>
            <div className="tm-fw-deps__box">
              <Mono className="tm-fw-deps__label">Blocked by · 1</Mono>
              <span>Brand asset pack (client upload)</span>
            </div>
            <span className="tm-fw-deps__plus">+</span>
            <div className="tm-fw-deps__box tm-fw-deps__box--this">
              <Mono className="tm-fw-deps__label">This task</Mono>
              <span>Prepare mobile booking flow concepts</span>
            </div>
            <span className="tm-fw-deps__plus">+</span>
            <div className="tm-fw-deps__box">
              <Mono className="tm-fw-deps__label">Blocks · 2</Mono>
              <span>Mobile concept review</span>
              <span>Homepage direction milestone</span>
            </div>
            <p className="tm-fw-deps__warn">
              Adding “Mobile concept review” as a blocker would create a cycle. That link is refused
              with both objects named.
            </p>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── Views: list, board, timeline ────────────────────────────────────────────── */

const LIST_ROWS: readonly {
  type: string;
  title: string;
  who: string;
  state: CapsuleState;
  label: string;
  committed: string;
  forecast: string;
  late?: boolean;
  checked?: boolean;
}[] = [
  {
    type: 'DEL',
    title: 'Homepage Concept v2',
    who: 'OA',
    state: 'client',
    label: 'Client review',
    committed: '18 Aug',
    forecast: '18 Aug',
    checked: true,
  },
  {
    type: 'TSK',
    title: 'Prepare mobile booking flow concepts',
    who: 'LS',
    state: 'blocked',
    label: 'Blocked',
    committed: '20 Aug',
    forecast: '25 Aug',
    late: true,
    checked: true,
  },
  {
    type: 'TSK',
    title: 'Booking CTA microcopy — EN and AR',
    who: 'NF',
    state: 'future',
    label: 'Not started',
    committed: '19 Aug',
    forecast: '19 Aug',
    checked: true,
  },
  {
    type: 'DEC',
    title: 'Homepage direction — decision record',
    who: 'MH',
    state: 'current',
    label: 'In progress',
    committed: '18 Aug',
    forecast: '18 Aug',
  },
  {
    type: 'TSK',
    title: 'ترجمة صفحة الأسئلة الشائعة',
    who: 'NF',
    state: 'future',
    label: 'Not started',
    committed: '1 Sep',
    forecast: '8 Sep',
    late: true,
  },
  {
    type: 'REQ',
    title: 'Add Arabic booking FAQ before launch',
    who: 'SR',
    state: 'waiting',
    label: 'Needs triage',
    committed: 'not set',
    forecast: 'desired 3 Sep',
  },
];

export function ListViewScene() {
  const t = useT();
  return (
    <Scene label={t('ListViewScene.label')} className="tm-fw-scene--mini">
      <div className="tm-fw-list">
        <div className="tm-fw-list__row tm-fw-list__row--head">
          <span className="tm-fw-box tm-fw-box--ghost" />
          <Mono className="tm-fw-list__title">Work item</Mono>
          <Mono>Owner</Mono>
          <Mono className="tm-fw-list__state">State</Mono>
          <Mono>Committed</Mono>
          <Mono>Forecast</Mono>
        </div>
        <div className="tm-fw-list__row tm-fw-list__row--group">
          <Mono>Milestone · Homepage direction</Mono>
          <StateCapsule state="current">Current · 4 days</StateCapsule>
          <Mono>6 items</Mono>
        </div>
        {LIST_ROWS.map((row) => (
          <div key={row.title} className={cx('tm-fw-list__row', row.checked && 'is-checked')}>
            <span className={cx('tm-fw-box', row.checked && 'tm-fw-box--on')}>
              {row.checked ? <WebIcon name="check" size={12} /> : null}
            </span>
            <span className="tm-fw-list__title">
              <Mono>{row.type}</Mono>
              <Clip>{row.title}</Clip>
            </span>
            <Initials name={row.who} tone="ink" />
            <span className="tm-fw-list__state">
              <StateCapsule state={row.state}>{row.label}</StateCapsule>
            </span>
            <Mono>{row.committed}</Mono>
            <Mono className={row.late ? 'tm-fw-late' : undefined}>{row.forecast}</Mono>
          </div>
        ))}
      </div>
    </Scene>
  );
}

export function BoardViewScene() {
  const t = useT();
  return (
    <Scene label={t('BoardViewScene.label')} className="tm-fw-scene--mini">
      <div className="tm-fw-board__cols tm-fw-board__cols--mini">
        <BoardColumn title="Not started" count="10" cards={NOT_STARTED} />
        <BoardColumn title="In progress" count="9 / WIP 6" flag="At limit" cards={IN_PROGRESS} />
      </div>
    </Scene>
  );
}

const TIMELINE_ROWS: readonly {
  type: string;
  title: string;
  start: number;
  span: number;
  tone: 'ink' | 'late' | 'outline';
  slip?: string;
}[] = [
  { type: 'DEL', title: 'Homepage Concept v2', start: 8, span: 26, tone: 'ink' },
  {
    type: 'TSK',
    title: 'Prepare mobile booking concepts',
    start: 14,
    span: 24,
    tone: 'late',
    slip: '+5d',
  },
  { type: 'TSK', title: 'Migrate Arabic booking FAQ copy', start: 36, span: 22, tone: 'outline' },
  { type: 'TSK', title: 'Rebuild booking form validation', start: 46, span: 30, tone: 'late' },
  { type: 'TSK', title: 'Quality review pass', start: 66, span: 20, tone: 'outline' },
];

export function TimelineViewScene() {
  const t = useT();
  return (
    <Scene label={t('TimelineViewScene.label')} className="tm-fw-scene--mini">
      <div className="tm-fw-timeline">
        <div className="tm-fw-timeline__row tm-fw-timeline__row--head">
          <Mono className="tm-fw-timeline__name">Work</Mono>
          <span className="tm-fw-timeline__track tm-fw-timeline__scale">
            <Mono>Aug 12</Mono>
            <Mono className="tm-fw-timeline__today">Aug 18</Mono>
            <Mono>Aug 25</Mono>
          </span>
        </div>
        <div className="tm-fw-timeline__row">
          <Mono className="tm-fw-timeline__name">Milestones</Mono>
          <span className="tm-fw-timeline__track">
            <span className="tm-fw-timeline__milestone">
              <StateCapsule state="current">Homepage direction · 18 Aug</StateCapsule>
            </span>
          </span>
        </div>
        {TIMELINE_ROWS.map((row) => (
          <div key={row.title} className="tm-fw-timeline__row">
            <span className="tm-fw-timeline__name">
              <Mono>{row.type}</Mono>
              <Clip>{row.title}</Clip>
            </span>
            <span className="tm-fw-timeline__track">
              <span
                className={cx('tm-fw-bar', `tm-fw-bar--${row.tone}`)}
                style={{ insetInlineStart: `${row.start}%`, inlineSize: `${row.span}%` }}
              />
              {row.slip ? <Mono className="tm-fw-bar__slip tm-fw-late">{row.slip}</Mono> : null}
            </span>
          </div>
        ))}
        <Mono className="tm-fw-timeline__legend">
          Today line = committed · orange outline = forecast past committed · grey bar below =
          baseline
        </Mono>
      </div>
    </Scene>
  );
}

/* ── Projects & portfolio: Project Pulse plan ────────────────────────────────── */

const MILESTONES: readonly {
  title: string;
  mark: 'done' | 'current' | 'risk' | 'future';
  tag?: ReactNode;
  baseline: string;
  committed: string;
  forecast: string;
  late?: boolean;
  evidence: string;
}[] = [
  {
    title: 'Discovery complete',
    mark: 'done',
    baseline: '20 Jul',
    committed: '20 Jul',
    forecast: 'done',
    evidence: '3 / 3',
  },
  {
    title: 'Homepage direction',
    mark: 'current',
    tag: <StateCapsule state="current">Current</StateCapsule>,
    baseline: '18 Aug',
    committed: '18 Aug',
    forecast: '18 Aug',
    evidence: '2 / 6',
  },
  {
    title: 'Content migration',
    mark: 'risk',
    baseline: '1 Sep',
    committed: '1 Sep',
    forecast: '3 Sep',
    late: true,
    evidence: '4 / 11',
  },
  {
    title: 'Quality review',
    mark: 'future',
    baseline: '18 Sep',
    committed: '20 Sep',
    forecast: '24 Sep',
    late: true,
    evidence: '0 / 6',
  },
  {
    title: 'Launch',
    mark: 'future',
    tag: <Badge mono>Client commitment</Badge>,
    baseline: '30 Sep',
    committed: '30 Sep',
    forecast: '30 Sep',
    evidence: '0 / 4',
  },
];

const PULSE_TABS = ['Overview', 'Plan', 'Work', 'Story', 'Team', 'Settings'];

export function ProjectPulseScene() {
  const t = useT();
  return (
    <Scene label={t('ProjectPulseScene.label')} className="tm-fw-scene--pulse">
      <div className="tm-fw-pulse">
        <span className="tm-fw-seg tm-fw-seg--tabs">
          {PULSE_TABS.map((tab) => (
            <span key={tab} className={tab === 'Plan' ? 'is-on' : undefined}>
              {tab}
            </span>
          ))}
        </span>
        <Mono className="tm-fw-pulse__eyebrow">Atlas Website Relaunch · Plan</Mono>
        <p className="tm-web-header__title tm-fw-pulse__title">
          Five milestones, one committed launch
        </p>
        <div className="tm-fw-pulse__table">
          <div className="tm-fw-pulse__row tm-fw-pulse__row--head">
            <Mono>Milestone</Mono>
            <Mono className="tm-fw-pulse__baseline">Baseline</Mono>
            <Mono>Committed</Mono>
            <Mono>Forecast</Mono>
            <Mono>Evidence</Mono>
          </div>
          {MILESTONES.map((m) => (
            <div
              key={m.title}
              className={cx('tm-fw-pulse__row', m.mark === 'current' && 'is-current')}
            >
              <span className="tm-fw-pulse__name">
                <span className={cx('tm-fw-mark', `tm-fw-mark--${m.mark}`)} />
                <span className="tm-fw-pulse__label">{m.title}</span>
                {m.tag}
              </span>
              <Mono className="tm-fw-pulse__baseline">{m.baseline}</Mono>
              <span className="tm-fw-pulse__strong">{m.committed}</span>
              <span className={cx('tm-fw-pulse__strong', m.late && 'tm-fw-late')}>
                {m.forecast}
              </span>
              <Mono>{m.evidence}</Mono>
            </div>
          ))}
          <p className="tm-fw-pulse__note">
            Quality review absorbs the migration slip, so the launch commitment holds — but there is
            no float left. One more slip moves the client-facing date.
          </p>
        </div>
      </div>
    </Scene>
  );
}

/* ── Templates: phase strip preview ──────────────────────────────────────────── */

export type PhaseTone = 'internal' | 'client' | 'launch';

export function TemplatePreview({
  label,
  phases,
  steps,
}: {
  label: string;
  phases: readonly PhaseTone[];
  steps: readonly { title: string; when: string; tone: PhaseTone }[];
}) {
  return (
    <Scene label={label} className="tm-fw-scene--template">
      <div className="tm-fw-tpl">
        <span className="tm-fw-tpl__phases">
          {phases.map((tone, index) => (
            // The strip is a fixed, ordered sequence; the index is its identity.
            <span key={index} className={cx('tm-fw-tpl__phase', `tm-fw-tpl__phase--${tone}`)} />
          ))}
        </span>
        <ul className="tm-fw-tpl__steps">
          {steps.map((step) => (
            <li key={step.title}>
              <span className={cx('tm-fw-tpl__dot', `tm-fw-tpl__dot--${step.tone}`)} />
              <span className="tm-fw-tpl__step">{step.title}</span>
              <Mono>{step.when}</Mono>
            </li>
          ))}
        </ul>
      </div>
    </Scene>
  );
}
