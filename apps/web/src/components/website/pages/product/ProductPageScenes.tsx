'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { Wordmark } from '../../../brand/Wordmark';
import { CalloutPin } from '../../sections';
import { WebIcon, type WebIconName } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Product overview scenes (WEB-02). Each one is a small, real TManage screen composed from
 * packages/ui parts (StateCapsule, Avatar, Badge, Button) and website tokens — never a
 * screenshot. Like the shared scenes they are illustrations: the body is `inert`, hidden from
 * assistive tech, and one sentence of alternative text stands in for it.
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
    <figure className={cx('tm-web-scene', 'tm-pp-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-pp-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('tm-pp-mono', className)}>{children}</span>;
}

/* ── 1. App shell (big product visual) ────────────────────────────────────── */

const RAIL: readonly { icon: WebIconName; label: string; on?: boolean }[] = [
  { icon: 'grid', label: 'Home' },
  { icon: 'mail', label: 'Inbox' },
  { icon: 'chat', label: 'Chat' },
  { icon: 'work', label: 'Work', on: true },
  { icon: 'calendar', label: 'Calendar' },
  { icon: 'doc', label: 'Docs' },
  { icon: 'person', label: 'People' },
  { icon: 'chart', label: 'Insights' },
];

const STAGES: readonly { state: CapsuleState; label: string }[] = [
  { state: 'done', label: 'Brief' },
  { state: 'done', label: 'Moodboard' },
  { state: 'current', label: 'Concepts' },
  { state: 'client', label: 'Client review' },
  { state: 'future', label: 'Final files' },
];

const TASKS: readonly {
  title: string;
  state: CapsuleState;
  stateLabel: string;
  owner: string;
  due: string;
  late?: boolean;
}[] = [
  {
    title: 'Homepage Concept v2',
    state: 'current',
    stateLabel: 'In progress',
    owner: 'Maya Hassan',
    due: 'Today',
  },
  {
    title: 'Logo lockups for print',
    state: 'waiting',
    stateLabel: 'Waiting on client',
    owner: 'Lina Samir',
    due: 'Thu 18',
  },
  {
    title: 'Brand voice doc',
    state: 'client',
    stateLabel: 'Client review',
    owner: 'Karim Nabil',
    due: 'Fri 19',
  },
  {
    title: 'Icon set handoff',
    state: 'blocked',
    stateLabel: 'Blocked',
    owner: 'Maya Hassan',
    due: 'Overdue',
    late: true,
  },
  {
    title: 'Moodboard sign-off',
    state: 'done',
    stateLabel: 'Done',
    owner: 'Noor Fathy',
    due: 'Mon 15',
  },
  {
    title: 'Social templates',
    state: 'future',
    stateLabel: 'Planned',
    owner: 'Omar Adel',
    due: 'Next week',
  },
  {
    title: 'Booking CTA microcopy',
    state: 'current',
    stateLabel: 'In progress',
    owner: 'Noor Fathy',
    due: 'Wed 17',
  },
  {
    title: 'Arabic FAQ draft',
    state: 'waiting',
    stateLabel: 'Waiting on client',
    owner: 'Salma Riad',
    due: 'Fri 19',
  },
];

/** The editable app shell — rail, project list, work table and the details panel. */
export function AppShellScene() {
  return (
    <Scene
      label="The TManage team workspace: the Atlas Website Relaunch project with its stage track, a task table and the details panel of Homepage Concept v2."
      className="tm-pp-scene--shell"
    >
      <div className="tm-pp-shell">
        <div className="tm-pp-shell__rail">
          <span className="tm-pp-shell__mark">
            <Wordmark variant="icon" label="" />
          </span>
          {RAIL.map((item) => (
            <span
              key={item.label}
              className={cx('tm-pp-shell__rail-item', item.on && 'tm-pp-shell__rail-item--on')}
            >
              <span className="tm-pp-shell__rail-orb">
                <WebIcon name={item.icon} size={14} />
              </span>
              <Mono>{item.label}</Mono>
            </span>
          ))}
        </div>
        <div className="tm-pp-shell__nav">
          <Mono>Work</Mono>
          <ul className="tm-pp-shell__nav-list">
            <li className="tm-pp-shell__nav-pinned">
              My work
              <span className="tm-pp-pin tm-pp-pin--inline">
                <CalloutPin n={2} />
              </span>
            </li>
            <li className="tm-pp-shell__nav-on">Atlas relaunch</li>
            <li>Q3 retainer</li>
            <li>Meridian app</li>
            <li>Planning board</li>
            <li>Requests</li>
            <li>Archive</li>
          </ul>
          <p className="tm-pp-shell__nav-foot">
            Control center
            <span className="tm-pp-pin tm-pp-pin--inline">
              <CalloutPin n={4} />
            </span>
          </p>
        </div>
        <div className="tm-pp-shell__main">
          <p className="tm-pp-shell__crumb">Work › Atlas Website Relaunch</p>
          <div className="tm-pp-shell__head">
            <p className="tm-pp-shell__title">Atlas Website Relaunch</p>
            <Badge tone="client">Client</Badge>
            <span className="tm-pp-shell__head-actions">
              <Button tone="outline" size="compact">
                Preview as client
              </Button>
              <Button tone="ink" size="compact">
                New task
              </Button>
            </span>
          </div>
          <div className="tm-pp-shell__stages">
            {STAGES.map((stage, index) => (
              <span key={stage.label} className="tm-pp-shell__stage">
                {index > 0 ? <span className="tm-pp-shell__stage-line" /> : null}
                <StateCapsule state={stage.state}>{stage.label}</StateCapsule>
              </span>
            ))}
          </div>
          <div className="tm-pp-table">
            <div className="tm-pp-table__row tm-pp-table__row--head">
              <span className="tm-pp-table__head-cell">
                <Mono>Task</Mono>
                <span className="tm-pp-pin tm-pp-pin--inline">
                  <CalloutPin n={1} />
                </span>
              </span>
              <Mono>State</Mono>
              <Mono className="tm-pp-col--owner">Owner</Mono>
              <Mono className="tm-pp-col--due">Due</Mono>
            </div>
            {TASKS.map((task) => (
              <div key={task.title} className="tm-pp-table__row">
                <span className="tm-pp-table__title">{task.title}</span>
                <span>
                  <StateCapsule state={task.state}>{task.stateLabel}</StateCapsule>
                </span>
                <span className="tm-pp-col--owner">
                  <Avatar name={task.owner} size="compact" decorative />
                </span>
                <span className={cx('tm-pp-col--due', task.late && 'tm-pp-late')}>{task.due}</span>
              </div>
            ))}
            <p className="tm-pp-table__foot">
              <Mono>8 of 24 items · Group by milestone</Mono>
              <span className="tm-pp-underline">Show all</span>
            </p>
          </div>
        </div>
        <div className="tm-pp-shell__details">
          <Mono>Details</Mono>
          <p className="tm-pp-shell__details-title">Homepage Concept v2</p>
          <span className="tm-pp-row">
            <StateCapsule state="current">In progress</StateCapsule>
            <Badge mono>TM-1042</Badge>
          </span>
          <span className="tm-pp-field">
            <span className="tm-pp-field__label">Project name</span>
            <span className="tm-pp-field__input">Q3 brand refresh</span>
            <span className="tm-pp-field__hint">Clients never see this name.</span>
          </span>
          <span className="tm-pp-client-box">
            <WebIcon name="portal" size={14} />
            Clients will see this section.
          </span>
          <span className="tm-pp-switch">
            <span className="tm-pp-switch__track">
              <span className="tm-pp-switch__thumb" />
            </span>
            Show in client portal
          </span>
          <span className="tm-pp-row">
            <Button tone="lime" size="compact">
              Publish to client
            </Button>
            <Button tone="text" size="compact">
              Request changes
            </Button>
          </span>
          <span className="tm-pp-toast">
            <WebIcon name="check" size={14} />
            <span className="tm-pp-toast__text">Task created from message</span>
            <strong>Undo</strong>
          </span>
          <span className="tm-pp-pin tm-pp-pin--details">
            <CalloutPin n={3} />
          </span>
        </div>
      </div>
    </Scene>
  );
}

/* ── 2. Team workspace — the work list ────────────────────────────────────── */

const WORK_ROWS: readonly {
  kind: string;
  title: string;
  owner: string;
  state: CapsuleState;
  stateLabel: string;
  committed: string;
  forecast: string;
  late?: boolean;
}[] = [
  {
    kind: 'DEL',
    title: 'Homepage Concept v2',
    owner: 'Omar Adel',
    state: 'client',
    stateLabel: 'Client review',
    committed: '18 Aug',
    forecast: '18 Aug',
  },
  {
    kind: 'TSK',
    title: 'Prepare mobile booking flow',
    owner: 'Lina Samir',
    state: 'blocked',
    stateLabel: 'Blocked',
    committed: '20 Aug',
    forecast: '25 Aug',
    late: true,
  },
  {
    kind: 'TSK',
    title: 'Booking CTA microcopy',
    owner: 'Noor Fathy',
    state: 'future',
    stateLabel: 'Not started',
    committed: '19 Aug',
    forecast: '19 Aug',
  },
  {
    kind: 'REQ',
    title: 'Add Arabic booking FAQ',
    owner: 'Salma Riad',
    state: 'waiting',
    stateLabel: 'Needs triage',
    committed: 'not set',
    forecast: '—',
  },
  {
    kind: 'TSK',
    title: 'Migrate Arabic booking pages',
    owner: 'Karim Nabil',
    state: 'current',
    stateLabel: 'In progress',
    committed: '1 Sep',
    forecast: '3 Sep',
    late: true,
  },
];

export function WorkListScene() {
  return (
    <Scene
      label="The Delivery risk saved view: work items grouped by milestone with owner, state, and committed and forecast dates kept apart."
      className="tm-pp-scene--card"
    >
      <div className="tm-pp-work">
        <div className="tm-pp-work__list">
          <Mono>Work · Saved view</Mono>
          <div className="tm-pp-work__head">
            <p className="tm-pp-scene-title">Delivery risk</p>
            <span className="tm-pp-work__meta">214 items · 3 blocked</span>
          </div>
          <div className="tm-pp-row">
            <span className="tm-web-chip tm-web-chip--on">List</span>
            <span className="tm-web-chip">Board</span>
            <span className="tm-web-chip">Timeline</span>
            <span className="tm-web-chip tm-pp-chip--wide">Workload</span>
          </div>
          <div className="tm-pp-bulk">
            <span className="tm-pp-bulk__count">1 selected</span>
            <span>Set owner</span>
            <span>Commit date</span>
            <span className="tm-pp-bulk__wide">Move to milestone</span>
            <span className="tm-pp-bulk__wide">Publish to client</span>
          </div>
          <div className="tm-pp-table tm-pp-table--work">
            <div className="tm-pp-table__row tm-pp-table__row--head">
              <Mono>Work item</Mono>
              <Mono>State</Mono>
              <Mono className="tm-pp-col--committed">Committed</Mono>
              <Mono className="tm-pp-col--forecast">Forecast</Mono>
            </div>
            <div className="tm-pp-table__row tm-pp-table__row--group">
              <Mono>Milestone · Homepage direction</Mono>
              <StateCapsule state="current">Current · 4 days</StateCapsule>
            </div>
            {WORK_ROWS.map((row, index) => (
              <div
                key={row.title}
                className={cx('tm-pp-table__row', index === 0 && 'tm-pp-table__row--live')}
              >
                <span className="tm-pp-table__title">
                  <Mono>{row.kind}</Mono>
                  <Avatar name={row.owner} size="compact" decorative />
                  {row.title}
                </span>
                <span>
                  <StateCapsule state={row.state}>{row.stateLabel}</StateCapsule>
                </span>
                <span className="tm-pp-col--committed">{row.committed}</span>
                <span className={cx('tm-pp-col--forecast', row.late && 'tm-pp-late')}>
                  {row.forecast}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── 3. Focus space — the inbox ───────────────────────────────────────────── */

const INBOX: readonly {
  group: string;
  count: string;
  tag?: string;
  rows: readonly { who: string; client?: boolean; text: string; time: string; due?: boolean }[];
}[] = [
  {
    group: 'Homepage Concept v2',
    count: '6 events',
    tag: 'Needs you',
    rows: [
      {
        who: 'Youssef Kamal',
        client: true,
        text: 'Approval still not started',
        time: '26h',
        due: true,
      },
      { who: 'Lina Samir', text: 'Marked v2 ready for client review', time: '11:02' },
      { who: 'Maya Hassan', text: 'Passed internal review · 4 of 4 criteria', time: '09:48' },
    ],
  },
  {
    group: '#atlas-relaunch',
    count: '14 events',
    rows: [
      { who: 'Salma Riad', client: true, text: 'Mentioned you in a thread', time: '10:58' },
      { who: 'Karim Nabil', text: 'Shared 3 files in the channel', time: '09:12' },
    ],
  },
  {
    group: 'Automation · Chase client approvals',
    count: '3 events',
    rows: [
      { who: 'Automation', text: 'Run skipped · reviewer authority had moved', time: '08:00' },
    ],
  },
];

export function InboxScene() {
  return (
    <Scene
      label="The focus inbox: notifications bundled by object, with the one approval that needs you first."
      className="tm-pp-scene--card"
    >
      <div className="tm-pp-inbox">
        {INBOX.map((bundle) => (
          <div key={bundle.group} className="tm-pp-inbox__bundle">
            <p className="tm-pp-inbox__group">
              <Mono className="tm-pp-mono--strong">{bundle.group}</Mono>
              {bundle.tag ? <span className="tm-pp-tag">{bundle.tag}</span> : null}
              <Mono>{bundle.count}</Mono>
            </p>
            {bundle.rows.map((row) => (
              <p key={row.text} className="tm-pp-inbox__row">
                <Avatar
                  name={row.who}
                  size="compact"
                  audience={row.client ? 'client' : 'internal'}
                  decorative
                />
                <span className="tm-pp-inbox__text">{row.text}</span>
                <Mono className={cx('tm-pp-time', row.due && 'tm-pp-due')}>{row.time}</Mono>
              </p>
            ))}
          </div>
        ))}
        <p className="tm-pp-inbox__more">
          <Mono>23 older events · load more</Mono>
        </p>
      </div>
    </Scene>
  );
}

/* ── 4. Client portal ─────────────────────────────────────────────────────── */

export function PortalScene() {
  return (
    <Scene
      label="The client portal for Atlas Hospitality: 47 days to launch, one action waiting, and the homepage direction approval first."
      className="tm-pp-scene--card"
    >
      <div className="tm-pp-portal">
        <div className="tm-pp-portal__bar">
          <span className="tm-pp-portal__org">
            <span className="tm-pp-shell__mark">
              <Wordmark variant="icon" label="" />
            </span>
            <span>
              <strong>Atlas Hospitality</strong>
              <Mono>Delivered by Northstar Studio</Mono>
            </span>
          </span>
          <span className="tm-pp-row">
            <span className="tm-pp-tab tm-pp-tab--on">Overview</span>
            <span className="tm-pp-tab">My actions</span>
            <span className="tm-pp-tab">Timeline</span>
          </span>
        </div>
        <div className="tm-pp-portal__hero">
          <div>
            <Mono>Your project · on track</Mono>
            <p className="tm-pp-scene-title tm-pp-scene-title--lg">Website relaunch</p>
            <p className="tm-pp-muted">
              Everything is moving toward launch on 30 September. One decision from you is needed
              this week.
            </p>
          </div>
          <span className="tm-pp-metric">
            <strong>47</strong>
            <span>days to launch</span>
          </span>
          <span className="tm-pp-metric">
            <strong>1</strong>
            <span>action waiting for you</span>
          </span>
        </div>
        <div className="tm-pp-portal__grid">
          <div className="tm-pp-side">
            <div className="tm-pp-action">
              <Mono>Approval · about 10 minutes</Mono>
              <p className="tm-pp-action__title">Approve the homepage direction</p>
              <p>
                Youssef Kamal is named as the reviewer. Approving this lets content migration start
                this week.
              </p>
              <span className="tm-pp-row">
                <Button tone="ink" size="compact">
                  Open the review
                </Button>
                <span className="tm-pp-underline">Ask a question instead</span>
              </span>
            </div>
            <div className="tm-pp-mini-card tm-pp-update">
              <Avatar name="Omar Adel" size="compact" decorative />
              <span>
                <span className="tm-pp-mini-card__title">Latest update · Omar Adel</span>
                <span className="tm-pp-muted">
                  “Homepage direction is with your reviewer. Content migration starts the same
                  week.”
                </span>
              </span>
            </div>
          </div>
          <div className="tm-pp-side tm-pp-side--aside">
            <div className="tm-pp-mini-card">
              <p className="tm-pp-mini-card__title">Deliverables</p>
              <span className="tm-pp-deliverable">
                Homepage Concept v2
                <StateCapsule state="client">Waiting for your approval</StateCapsule>
              </span>
              <span className="tm-pp-deliverable">
                Discovery summary v3
                <StateCapsule state="done">Approved</StateCapsule>
              </span>
            </div>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── 5. Control center ────────────────────────────────────────────────────── */

const ADMIN_NAV: readonly { heading: string; items: readonly string[] }[] = [
  { heading: 'People', items: ['Overview', 'Members and roles', 'Client organizations'] },
  { heading: 'Work setup', items: ['Templates', 'Automations', 'Integrations'] },
  { heading: 'Trust', items: ['Security', 'Audit log', 'Data and retention', 'Billing'] },
];

export function AdminScene() {
  return (
    <Scene
      label="The control center: an offboarding decision with its impact first, policy counts and the audit trail of recent changes."
      className="tm-pp-scene--card"
    >
      <div className="tm-pp-admin">
        <div className="tm-pp-admin__nav">
          {ADMIN_NAV.map((group) => (
            <div key={group.heading} className="tm-pp-admin__group">
              <Mono>{group.heading}</Mono>
              {group.items.map((item, index) => (
                <span
                  key={item}
                  className={cx(
                    'tm-pp-admin__item',
                    group.heading === 'People' && index === 0 && 'tm-pp-admin__item--on',
                  )}
                >
                  {item}
                </span>
              ))}
            </div>
          ))}
        </div>
        <div className="tm-pp-admin__main">
          <Mono>Owner view · Maya Hassan</Mono>
          <span className="tm-pp-row">
            <p className="tm-pp-scene-title">What needs a decision</p>
            <Badge>Everything is logged</Badge>
          </span>
          <div className="tm-pp-decision">
            <Mono className="tm-pp-mono--on-ink">Act first</Mono>
            <p className="tm-pp-decision__title">
              Karim Nabil leaves on 22 Aug and still owns 14 work items and 1 committed milestone
            </p>
            <span className="tm-pp-decision__foot">
              <span className="tm-pp-decision__body">
                Transfer ownership before the last working day so nothing lands unowned.
              </span>
              <Button tone="lime" size="compact">
                Review offboarding impact
              </Button>
            </span>
          </div>
          <div className="tm-pp-admin__metrics">
            <span className="tm-pp-mini-card">
              <strong>3</strong>
              invitations waiting on a policy exception
            </span>
            <span className="tm-pp-mini-card">
              <strong>9 of 12</strong>
              seats used, next renewal 1 Oct
            </span>
            <span className="tm-pp-mini-card tm-pp-mini-card--warn">
              <strong>1</strong>
              integration token expired
            </span>
          </div>
          <div className="tm-pp-mini-card">
            <p className="tm-pp-mini-card__title">Recent changes to the way this studio works</p>
            <p className="tm-pp-log">
              <Mono>Today 09:40</Mono>
              Client-visible file defaults tightened
            </p>
            <p className="tm-pp-log">
              <Mono>Yest 16:12</Mono>
              “Content migration” stage added to a template
            </p>
            <p className="tm-pp-log">
              <Mono>13 Aug</Mono>
              Two-step sign-in required for approvers
            </p>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── 6. Bilingual — the same card, LTR and RTL ────────────────────────────── */

const BILINGUAL = [
  {
    dir: 'ltr',
    lang: 'en',
    tag: 'LTR · English',
    org: 'Northstar Studio',
    nameLabel: 'Studio name',
    portalLabel: 'Show in client portal',
    hint: 'Clients see this name on every update.',
    save: 'Save changes',
    cancel: 'Cancel',
  },
  {
    dir: 'rtl',
    lang: 'ar',
    tag: 'RTL · Arabic',
    org: 'استوديو نورث ستار',
    nameLabel: 'اسم الاستوديو',
    portalLabel: 'إظهار في بوابة العميل',
    hint: 'يرى العملاء هذا الاسم في كل تحديث.',
    save: 'حفظ التغييرات',
    cancel: 'إلغاء',
  },
] as const;

export function BilingualScene() {
  return (
    <Scene
      label="The same studio settings card twice: left-to-right in English and mirrored right-to-left in Arabic."
      className="tm-pp-scene--bilingual"
    >
      <div className="tm-pp-bilingual">
        {BILINGUAL.map((side) => (
          <div key={side.lang} className="tm-pp-bilingual__side" dir={side.dir} lang={side.lang}>
            <span className="tm-pp-bilingual__tag">
              <Mono>{side.tag}</Mono>
            </span>
            <div className="tm-pp-mini-card tm-pp-bilingual__card">
              <p className="tm-pp-scene-title">{side.org}</p>
              <span className="tm-pp-field">
                <span className="tm-pp-field__label">{side.nameLabel}</span>
                <span className="tm-pp-field__input">{side.org}</span>
                <span className="tm-pp-field__hint">{side.hint}</span>
              </span>
              <span className="tm-pp-switch">
                <span className="tm-pp-switch__track">
                  <span className="tm-pp-switch__thumb" />
                </span>
                {side.portalLabel}
              </span>
              <span className="tm-pp-row">
                <Button tone="ink" size="compact">
                  {side.save}
                </Button>
                <Button tone="outline" size="compact">
                  {side.cancel}
                </Button>
              </span>
            </div>
          </div>
        ))}
      </div>
    </Scene>
  );
}
