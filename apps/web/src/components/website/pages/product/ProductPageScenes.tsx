'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { Wordmark } from '../../../brand/Wordmark';
import { CalloutPin } from '../../sections';
import { WebIcon, type WebIconName } from '../../WebIcon';
import { cx } from '../../primitives';
import { translate, type MessageKey } from '../../../../lib/i18n/t';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { useT } from '../../../../lib/i18n/use-t';

/**
 * Product overview scenes (WEB-02). Each one is a small, real TManage screen composed from
 * packages/ui parts (StateCapsule, Avatar, Badge, Button) and website tokens — never a
 * screenshot. Like the shared scenes they are illustrations: the body is `inert`, hidden from
 * assistive tech, and one sentence of alternative text stands in for it.
 *
 * Every visible string is a `ProductPageScenes.*` key (L4), so the scenes follow the active
 * locale and the Arabic page shows Arabic screens. Product and company names (TManage, Northstar
 * Studio, Atlas Hospitality), version tags and ids stay Latin.
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

const RAIL: readonly { icon: WebIconName; label: MessageKey; on?: boolean }[] = [
  { icon: 'grid', label: 'ProductPageScenes.railHome' },
  { icon: 'mail', label: 'ProductPageScenes.railInbox' },
  { icon: 'chat', label: 'ProductPageScenes.railChat' },
  { icon: 'work', label: 'ProductPageScenes.railWork', on: true },
  { icon: 'calendar', label: 'ProductPageScenes.railCalendar' },
  { icon: 'doc', label: 'ProductPageScenes.railDocs' },
  { icon: 'person', label: 'ProductPageScenes.railPeople' },
  { icon: 'chart', label: 'ProductPageScenes.railInsights' },
];

const NAV: readonly MessageKey[] = [
  'ProductPageScenes.navRetainer',
  'ProductPageScenes.navMeridian',
  'ProductPageScenes.navPlanning',
  'ProductPageScenes.navRequests',
  'ProductPageScenes.navArchive',
];

const STAGES: readonly { state: CapsuleState; label: MessageKey }[] = [
  { state: 'done', label: 'ProductPageScenes.stageBrief' },
  { state: 'done', label: 'ProductPageScenes.stageMoodboard' },
  { state: 'current', label: 'ProductPageScenes.stageConcepts' },
  { state: 'client', label: 'ProductPageScenes.stateClientReview' },
  { state: 'future', label: 'ProductPageScenes.stageFinalFiles' },
];

const TASKS: readonly {
  title: MessageKey;
  state: CapsuleState;
  stateLabel: MessageKey;
  owner: MessageKey;
  due: MessageKey;
  late?: boolean;
}[] = [
  {
    title: 'ProductPageScenes.taskHomepageV2',
    state: 'current',
    stateLabel: 'ProductPageScenes.stateInProgress',
    owner: 'ProductPageScenes.nameMaya',
    due: 'ProductPageScenes.dueToday',
  },
  {
    title: 'ProductPageScenes.taskLogoLockups',
    state: 'waiting',
    stateLabel: 'ProductPageScenes.stateWaitingOnClient',
    owner: 'ProductPageScenes.nameLina',
    due: 'ProductPageScenes.dueThu18',
  },
  {
    title: 'ProductPageScenes.taskBrandVoice',
    state: 'client',
    stateLabel: 'ProductPageScenes.stateClientReview',
    owner: 'ProductPageScenes.nameKarim',
    due: 'ProductPageScenes.dueFri19',
  },
  {
    title: 'ProductPageScenes.taskIconSet',
    state: 'blocked',
    stateLabel: 'ProductPageScenes.stateBlocked',
    owner: 'ProductPageScenes.nameMaya',
    due: 'ProductPageScenes.dueOverdue',
    late: true,
  },
  {
    title: 'ProductPageScenes.taskMoodboardSignoff',
    state: 'done',
    stateLabel: 'ProductPageScenes.stateDone',
    owner: 'ProductPageScenes.nameNoor',
    due: 'ProductPageScenes.dueMon15',
  },
  {
    title: 'ProductPageScenes.taskSocialTemplates',
    state: 'future',
    stateLabel: 'ProductPageScenes.statePlanned',
    owner: 'ProductPageScenes.nameOmar',
    due: 'ProductPageScenes.dueNextWeek',
  },
  {
    title: 'ProductPageScenes.taskBookingCta',
    state: 'current',
    stateLabel: 'ProductPageScenes.stateInProgress',
    owner: 'ProductPageScenes.nameNoor',
    due: 'ProductPageScenes.dueWed17',
  },
  {
    title: 'ProductPageScenes.taskArabicFaq',
    state: 'waiting',
    stateLabel: 'ProductPageScenes.stateWaitingOnClient',
    owner: 'ProductPageScenes.nameSalma',
    due: 'ProductPageScenes.dueFri19',
  },
];

/** The editable app shell — rail, project list, work table and the details panel. */
export function AppShellScene() {
  const t = useT();
  return (
    <Scene label={t('ProductPageScenes.appShellAlt')} className="tm-pp-scene--shell">
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
              <Mono>{t(item.label)}</Mono>
            </span>
          ))}
        </div>
        <div className="tm-pp-shell__nav">
          <Mono>{t('ProductPageScenes.railWork')}</Mono>
          <ul className="tm-pp-shell__nav-list">
            <li className="tm-pp-shell__nav-pinned">
              {t('ProductPageScenes.navMyWork')}
              <span className="tm-pp-pin tm-pp-pin--inline">
                <CalloutPin n={2} />
              </span>
            </li>
            <li className="tm-pp-shell__nav-on">{t('ProductPageScenes.navAtlas')}</li>
            {NAV.map((item) => (
              <li key={item}>{t(item)}</li>
            ))}
          </ul>
          <p className="tm-pp-shell__nav-foot">
            {t('ProductPageScenes.navControl')}
            <span className="tm-pp-pin tm-pp-pin--inline">
              <CalloutPin n={4} />
            </span>
          </p>
        </div>
        <div className="tm-pp-shell__main">
          <p className="tm-pp-shell__crumb">{t('ProductPageScenes.shellCrumb')}</p>
          <div className="tm-pp-shell__head">
            <p className="tm-pp-shell__title">{t('ProductPageScenes.projectTitle')}</p>
            <Badge tone="client">{t('ProductPageScenes.badgeClient')}</Badge>
            <span className="tm-pp-shell__head-actions">
              <Button tone="outline" size="compact">
                {t('ProductPageScenes.shellPreview')}
              </Button>
              <Button tone="ink" size="compact">
                {t('ProductPageScenes.shellNewTask')}
              </Button>
            </span>
          </div>
          <div className="tm-pp-shell__stages">
            {STAGES.map((stage, index) => (
              <span key={stage.label} className="tm-pp-shell__stage">
                {index > 0 ? <span className="tm-pp-shell__stage-line" /> : null}
                <StateCapsule state={stage.state}>{t(stage.label)}</StateCapsule>
              </span>
            ))}
          </div>
          <div className="tm-pp-table">
            <div className="tm-pp-table__row tm-pp-table__row--head">
              <span className="tm-pp-table__head-cell">
                <Mono>{t('ProductPageScenes.colTask')}</Mono>
                <span className="tm-pp-pin tm-pp-pin--inline">
                  <CalloutPin n={1} />
                </span>
              </span>
              <Mono>{t('ProductPageScenes.colState')}</Mono>
              <Mono className="tm-pp-col--owner">{t('ProductPageScenes.colOwner')}</Mono>
              <Mono className="tm-pp-col--due">{t('ProductPageScenes.colDue')}</Mono>
            </div>
            {TASKS.map((task) => (
              <div key={task.title} className="tm-pp-table__row">
                <span className="tm-pp-table__title">{t(task.title)}</span>
                <span>
                  <StateCapsule state={task.state}>{t(task.stateLabel)}</StateCapsule>
                </span>
                <span className="tm-pp-col--owner">
                  <Avatar name={t(task.owner)} size="compact" decorative />
                </span>
                <span className={cx('tm-pp-col--due', task.late && 'tm-pp-late')}>
                  {t(task.due)}
                </span>
              </div>
            ))}
            <p className="tm-pp-table__foot">
              <Mono>{t('ProductPageScenes.tableFoot')}</Mono>
              <span className="tm-pp-underline">{t('ProductPageScenes.showAll')}</span>
            </p>
          </div>
        </div>
        <div className="tm-pp-shell__details">
          <Mono>{t('ProductPageScenes.detailsHeading')}</Mono>
          <p className="tm-pp-shell__details-title">{t('ProductPageScenes.taskHomepageV2')}</p>
          <span className="tm-pp-row">
            <StateCapsule state="current">{t('ProductPageScenes.stateInProgress')}</StateCapsule>
            <Badge mono>TM-1042</Badge>
          </span>
          <span className="tm-pp-field">
            <span className="tm-pp-field__label">{t('ProductPageScenes.fieldProjectName')}</span>
            <span className="tm-pp-field__input">{t('ProductPageScenes.fieldProjectValue')}</span>
            <span className="tm-pp-field__hint">{t('ProductPageScenes.fieldHint')}</span>
          </span>
          <span className="tm-pp-client-box">
            <WebIcon name="portal" size={14} />
            {t('ProductPageScenes.clientBox')}
          </span>
          <span className="tm-pp-switch">
            <span className="tm-pp-switch__track">
              <span className="tm-pp-switch__thumb" />
            </span>
            {t('ProductPageScenes.switchPortal')}
          </span>
          <span className="tm-pp-row">
            <Button tone="lime" size="compact">
              {t('ProductPageScenes.publishClient')}
            </Button>
            <Button tone="text" size="compact">
              {t('ProductPageScenes.requestChanges')}
            </Button>
          </span>
          <span className="tm-pp-toast">
            <WebIcon name="check" size={14} />
            <span className="tm-pp-toast__text">{t('ProductPageScenes.toastText')}</span>
            <strong>{t('ProductPageScenes.toastUndo')}</strong>
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

const VIEWS: readonly MessageKey[] = [
  'ProductPageScenes.viewList',
  'ProductPageScenes.viewBoard',
  'ProductPageScenes.viewTimeline',
  'ProductPageScenes.viewWorkload',
];

const WORK_ROWS: readonly {
  kind: MessageKey;
  title: MessageKey;
  owner: MessageKey;
  state: CapsuleState;
  stateLabel: MessageKey;
  committed: MessageKey;
  forecast: MessageKey | null;
  late?: boolean;
}[] = [
  {
    kind: 'ProductPageScenes.kindDel',
    title: 'ProductPageScenes.taskHomepageV2',
    owner: 'ProductPageScenes.nameOmar',
    state: 'client',
    stateLabel: 'ProductPageScenes.stateClientReview',
    committed: 'ProductPageScenes.date18Aug',
    forecast: 'ProductPageScenes.date18Aug',
  },
  {
    kind: 'ProductPageScenes.kindTsk',
    title: 'ProductPageScenes.workMobileFlow',
    owner: 'ProductPageScenes.nameLina',
    state: 'blocked',
    stateLabel: 'ProductPageScenes.stateBlocked',
    committed: 'ProductPageScenes.date20Aug',
    forecast: 'ProductPageScenes.date25Aug',
    late: true,
  },
  {
    kind: 'ProductPageScenes.kindTsk',
    title: 'ProductPageScenes.taskBookingCta',
    owner: 'ProductPageScenes.nameNoor',
    state: 'future',
    stateLabel: 'ProductPageScenes.stateNotStarted',
    committed: 'ProductPageScenes.date19Aug',
    forecast: 'ProductPageScenes.date19Aug',
  },
  {
    kind: 'ProductPageScenes.kindReq',
    title: 'ProductPageScenes.workArabicFaq',
    owner: 'ProductPageScenes.nameSalma',
    state: 'waiting',
    stateLabel: 'ProductPageScenes.stateNeedsTriage',
    committed: 'ProductPageScenes.dateNotSet',
    forecast: null,
  },
  {
    kind: 'ProductPageScenes.kindTsk',
    title: 'ProductPageScenes.workMigrate',
    owner: 'ProductPageScenes.nameKarim',
    state: 'current',
    stateLabel: 'ProductPageScenes.stateInProgress',
    committed: 'ProductPageScenes.date1Sep',
    forecast: 'ProductPageScenes.date3Sep',
    late: true,
  },
];

export function WorkListScene() {
  const t = useT();
  return (
    <Scene label={t('ProductPageScenes.workListAlt')} className="tm-pp-scene--card">
      <div className="tm-pp-work">
        <div className="tm-pp-work__list">
          <Mono>{t('ProductPageScenes.workKicker')}</Mono>
          <div className="tm-pp-work__head">
            <p className="tm-pp-scene-title">{t('ProductPageScenes.workTitle')}</p>
            <span className="tm-pp-work__meta">{t('ProductPageScenes.workMeta')}</span>
          </div>
          <div className="tm-pp-row">
            {VIEWS.map((view, index) => (
              <span
                key={view}
                className={cx(
                  'tm-web-chip',
                  index === 0 && 'tm-web-chip--on',
                  index === VIEWS.length - 1 && 'tm-pp-chip--wide',
                )}
              >
                {t(view)}
              </span>
            ))}
          </div>
          <div className="tm-pp-bulk">
            <span className="tm-pp-bulk__count">{t('ProductPageScenes.bulkSelected')}</span>
            <span>{t('ProductPageScenes.bulkOwner')}</span>
            <span>{t('ProductPageScenes.bulkCommit')}</span>
            <span className="tm-pp-bulk__wide">{t('ProductPageScenes.bulkMove')}</span>
            <span className="tm-pp-bulk__wide">{t('ProductPageScenes.publishClient')}</span>
          </div>
          <div className="tm-pp-table tm-pp-table--work">
            <div className="tm-pp-table__row tm-pp-table__row--head">
              <Mono>{t('ProductPageScenes.colWorkItem')}</Mono>
              <Mono>{t('ProductPageScenes.colState')}</Mono>
              <Mono className="tm-pp-col--committed">{t('ProductPageScenes.colCommitted')}</Mono>
              <Mono className="tm-pp-col--forecast">{t('ProductPageScenes.colForecast')}</Mono>
            </div>
            <div className="tm-pp-table__row tm-pp-table__row--group">
              <Mono>{t('ProductPageScenes.groupMilestone')}</Mono>
              <StateCapsule state="current">{t('ProductPageScenes.groupCurrent')}</StateCapsule>
            </div>
            {WORK_ROWS.map((row, index) => (
              <div
                key={row.title}
                className={cx('tm-pp-table__row', index === 0 && 'tm-pp-table__row--live')}
              >
                <span className="tm-pp-table__title">
                  <Mono>{t(row.kind)}</Mono>
                  <Avatar name={t(row.owner)} size="compact" decorative />
                  {t(row.title)}
                </span>
                <span>
                  <StateCapsule state={row.state}>{t(row.stateLabel)}</StateCapsule>
                </span>
                <span className="tm-pp-col--committed">{t(row.committed)}</span>
                <span className={cx('tm-pp-col--forecast', row.late && 'tm-pp-late')}>
                  {row.forecast ? t(row.forecast) : '—'}
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
  /** A message key, or a literal for a channel slug, which stays as typed. */
  group: MessageKey | { literal: string };
  count: MessageKey;
  tag?: MessageKey;
  rows: readonly {
    who: MessageKey;
    client?: boolean;
    text: MessageKey;
    time: MessageKey | { literal: string };
    due?: boolean;
  }[];
}[] = [
  {
    group: 'ProductPageScenes.taskHomepageV2',
    count: 'ProductPageScenes.inboxCount6',
    tag: 'ProductPageScenes.inboxNeedsYou',
    rows: [
      {
        who: 'ProductPageScenes.nameYoussef',
        client: true,
        text: 'ProductPageScenes.inboxApprovalNotStarted',
        time: 'ProductPageScenes.inboxTime26h',
        due: true,
      },
      {
        who: 'ProductPageScenes.nameLina',
        text: 'ProductPageScenes.inboxMarkedReady',
        time: { literal: '11:02' },
      },
      {
        who: 'ProductPageScenes.nameMaya',
        text: 'ProductPageScenes.inboxPassedReview',
        time: { literal: '09:48' },
      },
    ],
  },
  {
    group: { literal: '#atlas-relaunch' },
    count: 'ProductPageScenes.inboxCount14',
    rows: [
      {
        who: 'ProductPageScenes.nameSalma',
        client: true,
        text: 'ProductPageScenes.inboxMentioned',
        time: { literal: '10:58' },
      },
      {
        who: 'ProductPageScenes.nameKarim',
        text: 'ProductPageScenes.inboxShared',
        time: { literal: '09:12' },
      },
    ],
  },
  {
    group: 'ProductPageScenes.inboxAutomationGroup',
    count: 'ProductPageScenes.inboxCount3',
    rows: [
      {
        who: 'ProductPageScenes.inboxAutomationWho',
        text: 'ProductPageScenes.inboxRunSkipped',
        time: { literal: '08:00' },
      },
    ],
  },
];

export function InboxScene() {
  const t = useT();
  const say = (value: MessageKey | { literal: string }) =>
    typeof value === 'string' ? t(value) : value.literal;
  return (
    <Scene label={t('ProductPageScenes.inboxAlt')} className="tm-pp-scene--card">
      <div className="tm-pp-inbox">
        {INBOX.map((bundle) => (
          <div key={say(bundle.group)} className="tm-pp-inbox__bundle">
            <p className="tm-pp-inbox__group">
              <Mono className="tm-pp-mono--strong">{say(bundle.group)}</Mono>
              {bundle.tag ? <span className="tm-pp-tag">{t(bundle.tag)}</span> : null}
              <Mono>{t(bundle.count)}</Mono>
            </p>
            {bundle.rows.map((row) => (
              <p key={row.text} className="tm-pp-inbox__row">
                <Avatar
                  name={t(row.who)}
                  size="compact"
                  audience={row.client ? 'client' : 'internal'}
                  decorative
                />
                <span className="tm-pp-inbox__text">{t(row.text)}</span>
                <Mono className={cx('tm-pp-time', row.due && 'tm-pp-due')}>{say(row.time)}</Mono>
              </p>
            ))}
          </div>
        ))}
        <p className="tm-pp-inbox__more">
          <Mono>{t('ProductPageScenes.inboxMore')}</Mono>
        </p>
      </div>
    </Scene>
  );
}

/* ── 4. Client portal ─────────────────────────────────────────────────────── */

const PORTAL_TABS: readonly MessageKey[] = [
  'ProductPageScenes.tabOverview',
  'ProductPageScenes.tabMyActions',
  'ProductPageScenes.tabTimeline',
];

export function PortalScene() {
  const t = useT();
  return (
    <Scene label={t('ProductPageScenes.portalAlt')} className="tm-pp-scene--card">
      <div className="tm-pp-portal">
        <div className="tm-pp-portal__bar">
          <span className="tm-pp-portal__org">
            <span className="tm-pp-shell__mark">
              <Wordmark variant="icon" label="" />
            </span>
            <span>
              <strong>Atlas Hospitality</strong>
              <Mono>{t('ProductPageScenes.portalDeliveredBy')}</Mono>
            </span>
          </span>
          <span className="tm-pp-row">
            {PORTAL_TABS.map((tab, index) => (
              <span key={tab} className={cx('tm-pp-tab', index === 0 && 'tm-pp-tab--on')}>
                {t(tab)}
              </span>
            ))}
          </span>
        </div>
        <div className="tm-pp-portal__hero">
          <div>
            <Mono>{t('ProductPageScenes.portalKicker')}</Mono>
            <p className="tm-pp-scene-title tm-pp-scene-title--lg">
              {t('ProductPageScenes.portalTitle')}
            </p>
            <p className="tm-pp-muted">{t('ProductPageScenes.portalBody')}</p>
          </div>
          <span className="tm-pp-metric">
            <strong>47</strong>
            <span>{t('ProductPageScenes.metricDays')}</span>
          </span>
          <span className="tm-pp-metric">
            <strong>1</strong>
            <span>{t('ProductPageScenes.metricAction')}</span>
          </span>
        </div>
        <div className="tm-pp-portal__grid">
          <div className="tm-pp-side">
            <div className="tm-pp-action">
              <Mono>{t('ProductPageScenes.actionKicker')}</Mono>
              <p className="tm-pp-action__title">{t('ProductPageScenes.actionTitle')}</p>
              <p>{t('ProductPageScenes.actionBody')}</p>
              <span className="tm-pp-row">
                <Button tone="ink" size="compact">
                  {t('ProductPageScenes.actionOpen')}
                </Button>
                <span className="tm-pp-underline">{t('ProductPageScenes.actionAsk')}</span>
              </span>
            </div>
            <div className="tm-pp-mini-card tm-pp-update">
              <Avatar name={t('ProductPageScenes.nameOmar')} size="compact" decorative />
              <span>
                <span className="tm-pp-mini-card__title">{t('ProductPageScenes.updateTitle')}</span>
                <span className="tm-pp-muted">{t('ProductPageScenes.updateQuote')}</span>
              </span>
            </div>
          </div>
          <div className="tm-pp-side tm-pp-side--aside">
            <div className="tm-pp-mini-card">
              <p className="tm-pp-mini-card__title">{t('ProductPageScenes.deliverablesTitle')}</p>
              <span className="tm-pp-deliverable">
                {t('ProductPageScenes.taskHomepageV2')}
                <StateCapsule state="client">
                  {t('ProductPageScenes.deliverableWaiting')}
                </StateCapsule>
              </span>
              <span className="tm-pp-deliverable">
                {t('ProductPageScenes.deliverableDiscovery')}
                <StateCapsule state="done">
                  {t('ProductPageScenes.deliverableApproved')}
                </StateCapsule>
              </span>
            </div>
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── 5. Control center ────────────────────────────────────────────────────── */

const ADMIN_NAV: readonly { heading: MessageKey; items: readonly MessageKey[] }[] = [
  {
    heading: 'ProductPageScenes.railPeople',
    items: [
      'ProductPageScenes.adminOverview',
      'ProductPageScenes.adminMembers',
      'ProductPageScenes.adminClientOrgs',
    ],
  },
  {
    heading: 'ProductPageScenes.adminWorkSetup',
    items: [
      'ProductPageScenes.adminTemplates',
      'ProductPageScenes.adminAutomations',
      'ProductPageScenes.adminIntegrations',
    ],
  },
  {
    heading: 'ProductPageScenes.adminTrust',
    items: [
      'ProductPageScenes.adminSecurity',
      'ProductPageScenes.adminAudit',
      'ProductPageScenes.adminData',
      'ProductPageScenes.adminBilling',
    ],
  },
];

const ADMIN_LOG: readonly { time: MessageKey; text: MessageKey }[] = [
  { time: 'ProductPageScenes.adminLog1Time', text: 'ProductPageScenes.adminLog1' },
  { time: 'ProductPageScenes.adminLog2Time', text: 'ProductPageScenes.adminLog2' },
  { time: 'ProductPageScenes.adminLog3Time', text: 'ProductPageScenes.adminLog3' },
];

export function AdminScene() {
  const t = useT();
  return (
    <Scene label={t('ProductPageScenes.adminAlt')} className="tm-pp-scene--card">
      <div className="tm-pp-admin">
        <div className="tm-pp-admin__nav">
          {ADMIN_NAV.map((group, groupIndex) => (
            <div key={group.heading} className="tm-pp-admin__group">
              <Mono>{t(group.heading)}</Mono>
              {group.items.map((item, index) => (
                <span
                  key={item}
                  className={cx(
                    'tm-pp-admin__item',
                    groupIndex === 0 && index === 0 && 'tm-pp-admin__item--on',
                  )}
                >
                  {t(item)}
                </span>
              ))}
            </div>
          ))}
        </div>
        <div className="tm-pp-admin__main">
          <Mono>{t('ProductPageScenes.adminOwnerView')}</Mono>
          <span className="tm-pp-row">
            <p className="tm-pp-scene-title">{t('ProductPageScenes.adminTitle')}</p>
            <Badge>{t('ProductPageScenes.adminLogged')}</Badge>
          </span>
          <div className="tm-pp-decision">
            <Mono className="tm-pp-mono--on-ink">{t('ProductPageScenes.adminActFirst')}</Mono>
            <p className="tm-pp-decision__title">{t('ProductPageScenes.adminDecisionTitle')}</p>
            <span className="tm-pp-decision__foot">
              <span className="tm-pp-decision__body">
                {t('ProductPageScenes.adminDecisionBody')}
              </span>
              <Button tone="lime" size="compact">
                {t('ProductPageScenes.adminReviewImpact')}
              </Button>
            </span>
          </div>
          <div className="tm-pp-admin__metrics">
            <span className="tm-pp-mini-card">
              <strong>3</strong>
              {t('ProductPageScenes.adminMetricInvites')}
            </span>
            <span className="tm-pp-mini-card">
              <strong>{t('ProductPageScenes.adminMetricSeatsValue')}</strong>
              {t('ProductPageScenes.adminMetricSeats')}
            </span>
            <span className="tm-pp-mini-card tm-pp-mini-card--warn">
              <strong>1</strong>
              {t('ProductPageScenes.adminMetricToken')}
            </span>
          </div>
          <div className="tm-pp-mini-card">
            <p className="tm-pp-mini-card__title">{t('ProductPageScenes.adminLogTitle')}</p>
            {ADMIN_LOG.map((entry) => (
              <p key={entry.text} className="tm-pp-log">
                <Mono>{t(entry.time)}</Mono>
                {t(entry.text)}
              </p>
            ))}
          </div>
        </div>
      </div>
    </Scene>
  );
}

/* ── 6. Bilingual — the same card, LTR and RTL ────────────────────────────── */

/*
 * The same studio settings card twice, left-to-right and mirrored right-to-left. Every string is a
 * `ProductPageScenes.bilingual*` key (N2). The right-to-left card always reads the Arabic catalog;
 * the left-to-right card follows the active locale. So the English page shows the card in English
 * and in Arabic, and the Arabic page shows the Arabic card in both directions — no English on the
 * Arabic page. The studio name (Northstar Studio) stays Latin, like every other scene.
 */
const BILINGUAL_ORG = 'Northstar Studio';

const BILINGUAL_FIELDS = {
  nameLabel: 'ProductPageScenes.bilingualNameLabel',
  hint: 'ProductPageScenes.bilingualHint',
  portalLabel: 'ProductPageScenes.bilingualPortalLabel',
  save: 'ProductPageScenes.bilingualSave',
  cancel: 'ProductPageScenes.bilingualCancel',
} as const satisfies Record<string, MessageKey>;

const BILINGUAL_SIDES = [
  { dir: 'ltr', tag: 'ProductPageScenes.bilingualTagLtrActive', fixedLocale: null },
  { dir: 'rtl', tag: 'ProductPageScenes.bilingualTagRtl', fixedLocale: 'ar' },
] as const satisfies readonly { dir: 'ltr' | 'rtl'; tag: MessageKey; fixedLocale: 'ar' | null }[];

export function BilingualScene() {
  const t = useT();
  const locale = useActiveLocale();
  return (
    <Scene label={t('ProductPageScenes.bilingualAltActive')} className="tm-pp-scene--bilingual">
      <div className="tm-pp-bilingual">
        {BILINGUAL_SIDES.map((side) => {
          const sideLocale = side.fixedLocale ?? locale;
          const lang = sideLocale.split('-')[0]?.toLowerCase() === 'ar' ? 'ar' : 'en';
          const s = (key: MessageKey) => translate(sideLocale, key);
          return (
            <div key={side.dir} className="tm-pp-bilingual__side" dir={side.dir} lang={lang}>
              <span className="tm-pp-bilingual__tag">
                <Mono>{t(side.tag)}</Mono>
              </span>
              <div className="tm-pp-mini-card tm-pp-bilingual__card">
                <p className="tm-pp-scene-title">{BILINGUAL_ORG}</p>
                <span className="tm-pp-field">
                  <span className="tm-pp-field__label">{s(BILINGUAL_FIELDS.nameLabel)}</span>
                  <span className="tm-pp-field__input">{BILINGUAL_ORG}</span>
                  <span className="tm-pp-field__hint">{s(BILINGUAL_FIELDS.hint)}</span>
                </span>
                <span className="tm-pp-switch">
                  <span className="tm-pp-switch__track">
                    <span className="tm-pp-switch__thumb" />
                  </span>
                  {s(BILINGUAL_FIELDS.portalLabel)}
                </span>
                <span className="tm-pp-row">
                  <Button tone="ink" size="compact">
                    {s(BILINGUAL_FIELDS.save)}
                  </Button>
                  <Button tone="outline" size="compact">
                    {s(BILINGUAL_FIELDS.cancel)}
                  </Button>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Scene>
  );
}
