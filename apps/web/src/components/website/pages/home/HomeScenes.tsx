'use client';

import type { ReactNode } from 'react';
import { StateCapsule } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { WebIcon, type WebIconName } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Home-page product scenes (WEB-01 / WEB-18, Figma "T-Manage Website" round 2, frames 308:26 and
 * 308:43). The desktop scenes are scaled clones of real TManage screens — My Day (HOME-01), the
 * chat convert-to-work panel, the client portal overview, the decision register and the audit
 * log — cropped by their frame exactly as the design crops them. Each one is an illustration, so
 * the body is `inert` and hidden from assistive tech and one sentence of `label` stands in.
 * Seed data only: Northstar Studio, Atlas Hospitality, "Atlas Website Relaunch".
 *
 * Every visible word reads from the `HomeScenes.*` catalog keys (live-check L3), so the page
 * mirrors fully in Arabic; brand names, channel names and IDs stay Latin inside the strings.
 */

type SceneT = (key: string) => string;

/** `HomeScenes.<key>` bound to the active locale. */
function useSceneT(): SceneT {
  const t = useT();
  return (key) => t(`HomeScenes.${key}` as MessageKey);
}

function HomeScene({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-web-scene', 'tm-home-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div className="tm-web-scene__body tm-home-scene__body" aria-hidden="true" inert>
        {children}
      </div>
    </figure>
  );
}

type PillTone = 'ink' | 'lime' | 'outline' | 'quiet' | 'warn' | 'danger' | 'client' | 'dim';

function Pill({
  tone = 'outline',
  icon,
  className,
  children,
}: {
  tone?: PillTone;
  icon?: WebIconName;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx('tm-hs-pill', `tm-hs-pill--${tone}`, className)}>
      {icon ? <WebIcon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('tm-hs-mono', className)}>{children}</span>;
}

function Dot({ tone }: { tone: 'lime' | 'ink' | 'paper' | 'warn' }) {
  return <span className={cx('tm-hs-dot', `tm-hs-dot--${tone}`)} aria-hidden="true" />;
}

/* ── HOME-01 My Day — one screen, cloned into the hero and the Team B row ────── */

const RAIL: readonly { label: MessageKey; icon: WebIconName; on?: boolean; count?: string }[] = [
  { label: 'nav.home', icon: 'flag', on: true },
  { label: 'nav.inbox', icon: 'mail', count: '3' },
  { label: 'nav.chat', icon: 'chat' },
  { label: 'nav.work', icon: 'list' },
  { label: 'nav.docs', icon: 'doc' },
  { label: 'nav.files', icon: 'layers' },
  { label: 'nav.clients', icon: 'portal' },
  { label: 'nav.insights', icon: 'chart' },
  { label: 'nav.control', icon: 'shield' },
];

function AppRail() {
  const t = useT();
  return (
    <div className="tm-hs-rail">
      <span className="tm-hs-rail__mark">T</span>
      {RAIL.map((item) => (
        <span
          key={item.label}
          className={cx('tm-hs-rail__item', item.on && 'tm-hs-rail__item--on')}
        >
          <span className="tm-hs-rail__orb">
            <WebIcon name={item.icon} size={14} />
            {item.count ? <span className="tm-hs-rail__count">{item.count}</span> : null}
          </span>
          <span className="tm-hs-rail__label">{t(item.label)}</span>
        </span>
      ))}
    </div>
  );
}

function MyDayScreen() {
  const s = useSceneT();
  return (
    <div className="tm-hs-screen tm-hs-myday">
      <AppRail />
      <div className="tm-hs-myday__main">
        <div className="tm-hs-strip">
          <span className="tm-hs-strip__today">
            <span className="tm-hs-strip__date">14</span>
            {s('todayStrip')}
          </span>
          <span className="tm-hs-strip__slot tm-hs-strip__slot--past">
            <Mono>09:30</Mono> {s('slotStandup')} <WebIcon name="check" size={12} />
          </span>
          <span className="tm-hs-strip__slot tm-hs-strip__slot--now">
            <Mono>{s('slotNow')}</Mono> {s('slotDesignReview')}
            <span className="tm-hs-faces">
              <span>LS</span>
              <span>KN</span>
            </span>
          </span>
          <span className="tm-hs-strip__slot">
            <Mono>14:00</Mono> {s('slotApprovalDue')}
          </span>
          <span className="tm-hs-strip__slot">
            <Mono>16:00</Mono> {s('slotFocus')}
          </span>
        </div>

        <div className="tm-hs-myday__body">
          <div className="tm-hs-myday__col">
            <p className="tm-hs-meta">
              <span>{s('metaOrg')}</span>
              <span className="tm-hs-meta__sep" />
              <span>{s('metaTime')}</span>
            </p>
            <div className="tm-hs-myday__head">
              <p className="tm-hs-myday__title">{s('myDayTitle')}</p>
              <span className="tm-hs-cta">
                <span className="tm-hs-cta__orb">
                  <WebIcon name="plus" size={12} />
                </span>
                {s('newWork')}
              </span>
              <div className="tm-hs-metrics">
                <span className="tm-hs-metric">
                  <span className="tm-hs-metric__value">04</span>
                  <Pill tone="lime" className="tm-hs-metric__tag">
                    {s('metricOnTrack')}
                  </Pill>
                  <span className="tm-hs-metric__label">{s('metricDaysToMilestone')}</span>
                  <span className="tm-hs-metric__note">{s('committed18Aug')}</span>
                </span>
                <span className="tm-hs-metric">
                  <span className="tm-hs-metric__value">{s('metricWaitValue')}</span>
                  <Pill tone="warn" className="tm-hs-metric__tag">
                    {s('metricWaiting')}
                  </Pill>
                  <span className="tm-hs-metric__label">{s('metricLongestWait')}</span>
                  <span className="tm-hs-metric__note">{s('conceptV2')}</span>
                </span>
                <span className="tm-hs-metric">
                  <span className="tm-hs-metric__value">3</span>
                  <Pill tone="danger" className="tm-hs-metric__tag">
                    {s('metricUp2')}
                  </Pill>
                  <span className="tm-hs-metric__label">{s('metricBlocked')}</span>
                  <span className="tm-hs-metric__note">{s('metricBlockedNote')}</span>
                </span>
              </div>
            </div>
            <p className="tm-hs-lede">{s('lede')}</p>

            <div className="tm-hs-focus">
              <span className="tm-hs-focus__play">
                <WebIcon name="play" size={12} />
              </span>
              <span className="tm-hs-focus__text">
                <span className="tm-hs-focus__title">{s('focusTitle')}</span>
                <span className="tm-hs-focus__why">{s('focusWhy')}</span>
              </span>
              <Pill tone="dim" icon="help">
                {s('clientActionRequired')}
              </Pill>
              <span className="tm-hs-focus__go">
                <WebIcon name="arrow-right" size={12} />
              </span>
            </div>

            <div className="tm-hs-row-head">
              <span className="tm-hs-row-head__title">{s('dueAtRisk')}</span>
              <span className="tm-hs-row-head__count">{s('sevenItems')}</span>
              <Pill tone="ink">{s('today')}</Pill>
              <Pill>{s('blocked3')}</Pill>
              <Pill>{s('clientWaiting2')}</Pill>
            </div>
            <div className="tm-hs-due">
              <div className="tm-hs-due__card tm-hs-due__card--lime">
                <span className="tm-hs-due__who">
                  <span className="tm-hs-face tm-hs-face--ink">OA</span>
                  {s('dueOwnDeliverable')}
                  <span className="tm-hs-due__open tm-hs-due__open--ink">
                    <WebIcon name="arrow-right" size={12} />
                  </span>
                </span>
                <span className="tm-hs-due__title">{s('duePublishTitle')}</span>
                <span className="tm-hs-due__meta">{s('duePublishMeta')}</span>
                <Pill tone="ink">{s('runSafetyCheck')}</Pill>
              </div>
              <div className="tm-hs-due__card">
                <span className="tm-hs-due__who">
                  <span className="tm-hs-face tm-hs-face--grey">LS</span>
                  {s('taskLina')}
                  <span className="tm-hs-due__open">
                    <WebIcon name="arrow-right" size={12} />
                  </span>
                </span>
                <span className="tm-hs-due__title">{s('mobileFlowTitle')}</span>
                <span className="tm-hs-due__meta">{s('mobileFlowMeta')}</span>
                <Pill tone="warn">
                  <Dot tone="warn" />
                  {s('blockedBrandAssets')}
                </Pill>
              </div>
              <div className="tm-hs-due__card">
                <span className="tm-hs-due__who">
                  <span className="tm-hs-face tm-hs-face--client">SR</span>
                  {s('requestSalma')}
                  <span className="tm-hs-due__open">
                    <WebIcon name="arrow-right" size={12} />
                  </span>
                </span>
                <span className="tm-hs-due__title">{s('arabicFaqTitle')}</span>
                <span className="tm-hs-due__warn">{s('notCommitted')}</span>
                <Pill tone="quiet">{s('needsTriage2d')}</Pill>
              </div>
            </div>

            <div className="tm-hs-row-head">
              <span className="tm-hs-row-head__title">{s('waitingOnOthers')}</span>
              <span className="tm-hs-row-head__count">{s('waitingOnOthersNote')}</span>
            </div>
            <div className="tm-hs-waits">
              <span className="tm-hs-wait">
                <span className="tm-hs-face tm-hs-face--client">YK</span>
                <span className="tm-hs-wait__title">{s('waitApprovalTitle')}</span>
                <span className="tm-hs-wait__state tm-hs-wait__state--warn">{s('waiting26h')}</span>
                <Mono>{s('due18Aug')}</Mono>
                <Pill>{s('nudge')}</Pill>
              </span>
              <span className="tm-hs-wait">
                <span className="tm-hs-face tm-hs-face--ink">NF</span>
                <span className="tm-hs-wait__title">{s('waitMigrateTitle')}</span>
                <span className="tm-hs-wait__state">{s('inProgress')}</span>
                <Mono>{s('forecast8Sep')}</Mono>
                <Pill>{s('open')}</Pill>
              </span>
              <span className="tm-hs-wait">
                <span className="tm-hs-face tm-hs-face--ink">MH</span>
                <span className="tm-hs-wait__title">{s('waitDecisionTitle')}</span>
                <span className="tm-hs-wait__state">{s('draft')}</span>
                <Mono>{s('noDate')}</Mono>
                <Pill>{s('open')}</Pill>
              </span>
            </div>
          </div>

          <div className="tm-hs-lens">
            <Mono className="tm-hs-lens__label">{s('contextLens')}</Mono>
            <span className="tm-hs-lens__title">{s('projectName')}</span>
            <span className="tm-hs-lens__tags">
              <Pill tone="lime">{s('homepageDirection')}</Pill>
              <span>{s('committed18Aug')}</span>
            </span>
            <Mono className="tm-hs-lens__label">{s('workStoryLast3')}</Mono>
            <ol className="tm-hs-lens__story">
              <li>
                <Mono>{s('story1When')}</Mono>
                <span>{s('story1What')}</span>
              </li>
              <li>
                <Mono>{s('story2When')}</Mono>
                <span>{s('story2What')}</span>
                <span className="tm-hs-lens__note">{s('story2Note')}</span>
              </li>
              <li>
                <Mono>{s('story3When')}</Mono>
                <span>{s('story3What')}</span>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Hero: an ink panel holding My Day, with three floating UI cards ─────────── */

export function HeroScene() {
  const s = useSceneT();
  return (
    <HomeScene label={s('heroLabel')} className="tm-home-hero-scene">
      <div className="tm-home-hero-scene__wide">
        <div className="tm-hs-panel">
          <div className="tm-hs-fit tm-hs-fit--hero">
            <MyDayScreen />
          </div>
        </div>
        <div className="tm-hs-float tm-hs-float--client">
          <StateCapsule state="client">{s('clientReview')}</StateCapsule>
          <span className="tm-hs-float__text">{s('floatWaiting')}</span>
        </div>
        <div className="tm-hs-float tm-hs-float--approved">
          <span className="tm-hs-float__badge">{s('floatApproved')}</span>
        </div>
        <div className="tm-hs-float tm-hs-float--chat">
          <span className="tm-hs-float__face">JR</span>
          <span className="tm-hs-float__chat">
            <span className="tm-hs-float__ask">{s('askArabicFaq')}</span>
            <span className="tm-hs-float__chip">
              <WebIcon name="arrow-right" size={14} />
              {s('requestCreated')}
            </span>
          </span>
        </div>
      </div>

      <div className="tm-home-hero-scene__narrow">
        <div className="tm-hs-stack">
          <div className="tm-hs-stack__card tm-hs-stack__card--lime">
            <span className="tm-hs-stack__who">
              <span className="tm-hs-face tm-hs-face--ink">YK</span>
              {s('youssefAtlas')}
              <strong>{s('owesUs26h')}</strong>
            </span>
            <span className="tm-hs-stack__title">{s('approvalOfConcept')}</span>
            <span className="tm-hs-stack__actions">
              <Pill tone="ink">{s('nudge')}</Pill>
              <Pill>{s('extend')}</Pill>
            </span>
          </div>
          <div className="tm-hs-stack__card">
            <span className="tm-hs-stack__who">
              <span className="tm-hs-face tm-hs-face--client">SR</span>
              {s('salmaNewRequest')}
              <Mono>{s('weOwe2d')}</Mono>
            </span>
            <span className="tm-hs-stack__title">{s('arabicFaqTitle')}</span>
            <span className="tm-hs-stack__note">{s('desired3Sep')}</span>
          </div>
          <div className="tm-hs-stack__card">
            <span className="tm-hs-stack__who">
              <span className="tm-hs-face tm-hs-face--client">RM</span>
              {s('raniaMeridian')}
              <Mono>{s('owesUs4d')}</Mono>
            </span>
            <span className="tm-hs-stack__title">{s('uploadBrandAssets')}</span>
            <span className="tm-hs-stack__note tm-hs-stack__note--warn">{s('uploadBlocking')}</span>
          </div>
          <div className="tm-hs-stack__card tm-hs-stack__card--peek">
            <span className="tm-hs-stack__who">
              <span className="tm-hs-face tm-hs-face--client">SR</span>
              {s('salmaQuestion')}
              <Mono>{s('weOwe2d')}</Mono>
            </span>
          </div>
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Team row A: the chat convert-to-work panel ──────────────────────────────── */

export function ChatConvertScene() {
  const s = useSceneT();
  return (
    <HomeScene label={s('chatThreadLabel')} className="tm-home-frame-scene">
      <div className="tm-hs-wide-only tm-hs-crop tm-hs-crop--end">
        <div className="tm-hs-screen tm-hs-chat">
          <div className="tm-hs-chat__bar">
            <span className="tm-hs-chat__channel">
              <span className="tm-hs-chat__name" dir="ltr">
                #atlas-relaunch
              </span>
              <span className="tm-hs-chat__members">{s('channelMembers')}</span>
            </span>
            <span className="tm-hs-visible">
              <span className="tm-hs-visible__ring" />
              {s('clientVisibleBanner')}
            </span>
            <span className="tm-hs-chat__tools">
              <span className="tm-hs-tool">
                <WebIcon name="search" size={12} />
              </span>
              <span className="tm-hs-tool">
                <WebIcon name="doc" size={12} />
              </span>
              <span className="tm-hs-tool">···</span>
            </span>
          </div>
          <div className="tm-hs-chat__split">
            <div className="tm-hs-chat__thread">
              <span className="tm-hs-pinned">
                {s('pinnedBrief')} <Mono>{s('twoObjects')}</Mono>
              </span>
              <div className="tm-hs-msg">
                <Mono>{s('msgLinaWho')}</Mono>
                <p>{s('msgLina')}</p>
              </div>
              <div className="tm-hs-msg">
                <span className="tm-hs-msg__head">
                  {s('salmaRiad')} <Pill tone="client">{s('client')}</Pill> <Mono>10:58</Mono>
                </span>
                <p>{s('msgSalma')}</p>
                <Pill tone="lime">{s('convertedToWork')}</Pill>
              </div>
              <div className="tm-hs-msg tm-hs-msg--picked">
                <Mono>{s('msgOmarWho')}</Mono>
                <p>{s('msgOmar')}</p>
                <span className="tm-hs-linked">
                  <span className="tm-hs-linked__text">
                    <span className="tm-hs-linked__title">{s('mobileFlowTitle')}</span>
                    <Mono>{s('linkedMeta')}</Mono>
                  </span>
                  <span className="tm-hs-linked__open">{s('open')}</span>
                </span>
              </div>
            </div>
            <div className="tm-hs-convert">
              <span className="tm-hs-convert__head">
                <Mono>{s('convertHead')}</Mono>
                <span className="tm-hs-tool">
                  <WebIcon name="close" size={12} />
                </span>
              </span>
              <span className="tm-hs-source">
                <span className="tm-hs-source__who">
                  <span className="tm-hs-face tm-hs-face--client">SR</span>
                  {s('sourceMessage')}
                </span>
                <span>{s('sourceQuote')}</span>
              </span>
              <span className="tm-hs-field">
                <span className="tm-hs-field__label">{s('workTitle')}</span>
                <span className="tm-hs-input tm-hs-input--focus">{s('mobileFlowTitle')}</span>
              </span>
              <span className="tm-hs-fields">
                <span className="tm-hs-field">
                  <span className="tm-hs-field__label">{s('owner')}</span>
                  <span className="tm-hs-input">
                    <span className="tm-hs-face tm-hs-face--grey">LS</span>
                    {s('linaSamir')}
                  </span>
                </span>
                <span className="tm-hs-field">
                  <span className="tm-hs-field__label">{s('committedDate')}</span>
                  <span className="tm-hs-input">{s('date20Aug2026')}</span>
                </span>
              </span>
              <span className="tm-hs-field">
                <span className="tm-hs-field__label">{s('audience')}</span>
                <span className="tm-hs-choice">
                  <Pill tone="ink">
                    <Dot tone="lime" />
                    {s('internal')}
                  </Pill>
                  <Pill>{s('clientVisible')}</Pill>
                </span>
              </span>
              <span className="tm-hs-alert">
                <span className="tm-hs-alert__icon">!</span>
                <span className="tm-hs-alert__text">
                  <span className="tm-hs-alert__title">{s('inheritedTitle')}</span>
                  <span>{s('inheritedBody')}</span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="tm-hs-narrow-only tm-hs-chat-m">
        <div className="tm-hs-chat-m__bubble">
          <span className="tm-hs-face tm-hs-face--client tm-hs-face--lg">YK</span>
          <span className="tm-hs-chat-m__text">
            <span className="tm-hs-chat-m__who">{s('youssefAtlas')}</span>
            {s('askArabicFaq')}
          </span>
        </div>
        <span className="tm-hs-chat-m__chip">
          <WebIcon name="arrow-right" size={12} />
          {s('requestCreated')}
        </span>
        <div className="tm-hs-chat-m__card">
          <span className="tm-hs-chat-m__head">
            <span className="tm-hs-chat-m__title">{s('arabicFaqShort')}</span>
            <StateCapsule state="current">{s('newRequest')}</StateCapsule>
          </span>
          <span className="tm-hs-chat-m__meta">{s('projectRequest')}</span>
          <span className="tm-hs-chat-m__foot">
            <span className="tm-hs-face tm-hs-face--grey tm-hs-face--lg">MS</span>
            <Pill className="tm-hs-pill--lg">{s('open')}</Pill>
            <Pill tone="ink" className="tm-hs-pill--lg">
              {s('approve')}
            </Pill>
          </span>
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Team row B: My Day, framed ──────────────────────────────────────────────── */

export function MyDayScene() {
  const s = useSceneT();
  return (
    <HomeScene label={s('myDayLabel')} className="tm-home-frame-scene">
      <div className="tm-hs-crop tm-hs-crop--start">
        <div className="tm-hs-fit tm-hs-fit--row">
          <MyDayScreen />
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Clients row and the portal spotlight: the client portal overview ───────── */

const PORTAL_NAV = [
  'portalMyActions',
  'portalTimeline',
  'portalDeliverables',
  'portalUpdates',
  'portalFiles',
  'portalPeople',
] as const;

function PortalScreen() {
  const s = useSceneT();
  return (
    <div className="tm-hs-screen tm-hs-portal">
      <div className="tm-hs-portal__bar">
        <span className="tm-hs-portal__org">
          <span className="tm-hs-rail__mark">T</span>
          <span className="tm-hs-portal__org-text">
            <span className="tm-hs-portal__org-name">Atlas Hospitality</span>
            <span>{s('deliveredBy')}</span>
          </span>
        </span>
        <span className="tm-hs-portal__nav">
          <Pill tone="ink">{s('portalOverview')}</Pill>
          {PORTAL_NAV.map((key) => (
            <span key={key}>{s(key)}</span>
          ))}
        </span>
        <Pill className="tm-hs-portal__me">
          <span className="tm-hs-face tm-hs-face--client">SR</span>
          {s('salmaRiad')}
        </Pill>
      </div>
      <div className="tm-hs-portal__body">
        <Mono>{s('portalOnTrack')}</Mono>
        <div className="tm-hs-portal__hero">
          <span className="tm-hs-portal__intro">
            <span className="tm-hs-portal__title">{s('portalTitle')}</span>
            <span className="tm-hs-lede">{s('portalLede')}</span>
          </span>
          <span className="tm-hs-metric">
            <span className="tm-hs-metric__value">47</span>
            <span className="tm-hs-metric__label">{s('daysToLaunch')}</span>
            <span className="tm-hs-metric__note">{s('committed30Sep')}</span>
          </span>
          <span className="tm-hs-metric">
            <span className="tm-hs-metric__value">1</span>
            <Pill tone="lime" className="tm-hs-metric__tag">
              {s('thisWeek')}
            </Pill>
            <span className="tm-hs-metric__label">{s('actionWaiting')}</span>
            <span className="tm-hs-metric__note">{s('approval10min')}</span>
          </span>
        </div>
        <p className="tm-hs-meta">
          <Mono>{s('whereProject')}</Mono>
          <span>{s('stage2of5')}</span>
        </p>
        <div className="tm-hs-stages">
          <span className="tm-hs-stage tm-hs-stage--done">
            <WebIcon name="check" size={12} />
            <span className="tm-hs-stage__text">
              {s('stageDiscovery')}
              <Mono>{s('done28Jul')}</Mono>
            </span>
          </span>
          <span className="tm-hs-stage tm-hs-stage--now">
            <span className="tm-hs-stage__text">
              <Mono>{s('now')}</Mono>
              {s('homepageDirection')}
            </span>
            <span className="tm-hs-stage__wait">
              {s('waitingYourApproval')}
              <Mono>{s('by18Aug')}</Mono>
            </span>
            <span className="tm-hs-face tm-hs-face--ink">YK</span>
          </span>
          <span className="tm-hs-stage">
            <span className="tm-hs-stage__text">
              {s('stageContent')}
              <Mono>{s('expectedEarlySep')}</Mono>
            </span>
          </span>
          <span className="tm-hs-stage">
            <span className="tm-hs-stage__text">
              {s('stageQuality')}
              <Mono>{s('date20Sep')}</Mono>
            </span>
          </span>
        </div>
        <div className="tm-hs-portal__cols">
          <div className="tm-hs-portal__actions">
            <span className="tm-hs-portal__h">{s('yourActions')}</span>
            <span className="tm-hs-action">
              <span className="tm-hs-action__meta">
                <Mono>{s('approvalAbout10')}</Mono>
                <Pill tone="ink">{s('dueOn18Aug')}</Pill>
              </span>
              <span className="tm-hs-action__title">{s('approveDirection')}</span>
              <span className="tm-hs-action__body">{s('approveDirectionBody')}</span>
              <span className="tm-hs-action__foot">
                <span className="tm-hs-cta">
                  <span className="tm-hs-cta__orb tm-hs-cta__orb--lime">
                    <WebIcon name="play" size={12} />
                  </span>
                  {s('openReview')}
                </span>
                <span className="tm-hs-link">{s('askInstead')}</span>
              </span>
            </span>
            <span className="tm-hs-ask">
              <span className="tm-hs-ask__icon">?</span>
              <span className="tm-hs-ask__text">
                <span className="tm-hs-ask__title">{s('answerFaqQuestion')}</span>
                <span>{s('omarAsked')}</span>
              </span>
              <Pill>{s('reply')}</Pill>
            </span>
            <span className="tm-hs-ask tm-hs-ask--quiet">
              <span className="tm-hs-ask__icon">
                <WebIcon name="check" size={12} />
              </span>
              {s('nothingElse')}
            </span>
          </div>
          <div className="tm-hs-portal__side">
            <span className="tm-hs-side-card">
              <span className="tm-hs-portal__h">{s('latestUpdate')}</span>
              <span className="tm-hs-quote">{s('updateQuote')}</span>
              <span className="tm-hs-source__who">
                <span className="tm-hs-face tm-hs-face--ink">OA</span>
                {s('omarPm')}
              </span>
            </span>
            <span className="tm-hs-side-card">
              <span className="tm-hs-portal__h">{s('deliverables')}</span>
              <span className="tm-hs-deliv">
                <span className="tm-hs-cta__orb tm-hs-cta__orb--lime">
                  <WebIcon name="play" size={12} />
                </span>
                <span className="tm-hs-deliv__text">
                  {s('conceptV2')}
                  <Mono>{s('waitingYourApprovalCap')}</Mono>
                </span>
              </span>
              <span className="tm-hs-deliv">
                <span className="tm-hs-cta__orb tm-hs-cta__orb--outline">
                  <WebIcon name="check" size={12} />
                </span>
                <span className="tm-hs-deliv__text">
                  {s('discoverySummary')}
                  <Mono>{s('approved28Jul')}</Mono>
                </span>
              </span>
            </span>
            <span className="tm-hs-side-card">
              <span className="tm-hs-portal__h">{s('yourTeam')}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PortalScene({ variant = 'row' }: { variant?: 'row' | 'spotlight' }) {
  const s = useSceneT();
  return (
    <HomeScene
      label={s('portalLabel')}
      className={cx('tm-home-frame-scene', variant === 'spotlight' && 'tm-home-spot-scene')}
    >
      <div
        className={cx('tm-hs-crop', variant === 'row' ? 'tm-hs-crop--start' : 'tm-hs-crop--card')}
      >
        <div
          className={cx('tm-hs-fit', variant === 'row' ? 'tm-hs-fit--portal' : 'tm-hs-fit--spot')}
        >
          <PortalScreen />
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Knowledge row: the decision register ────────────────────────────────────── */

/**
 * Sample register numbers from the round-2 design, built at load time. The source scan in
 * tests/ticket-ids.test.ts reads a letters-dash-three-digits literal as a planning-ticket id, and
 * these are demo decisions, not tickets.
 */
const decisionId = (n: number): string => ['DEC', String(n).padStart(3, '0')].join('-');

/** Each field is a `HomeScenes.*` key except `id` (a Latin register number). */
const DECISIONS: readonly {
  id: string;
  statement: string;
  owner: string;
  effective: string;
  affects: string | null;
  supersededBy?: string;
}[] = [
  {
    id: decisionId(115),
    statement: 'dec115',
    owner: 'linaSamir',
    effective: 'date14Aug',
    affects: 'items3',
  },
  {
    id: decisionId(114),
    statement: 'dec114',
    owner: 'omarAdel',
    effective: 'date14Aug',
    affects: 'items6',
  },
  {
    id: decisionId(109),
    statement: 'dec109',
    owner: 'omarAdel',
    effective: 'date22Jul',
    affects: 'allWork',
  },
  {
    id: decisionId(104),
    statement: 'dec104',
    owner: 'mayaHassan',
    effective: 'date18Jul',
    affects: 'items9',
  },
  {
    id: decisionId(98),
    statement: 'dec98',
    owner: 'linaSamir',
    effective: 'date6Aug',
    affects: null,
    supersededBy: decisionId(115),
  },
];

export function DecisionRegisterScene() {
  const s = useSceneT();
  return (
    <HomeScene label={s('decisionRegisterLabel')} className="tm-home-frame-scene">
      <div className="tm-hs-register">
        <div className="tm-hs-register__row tm-hs-register__row--head">
          <Mono>{s('colId')}</Mono>
          <Mono>{s('colStatement')}</Mono>
          <Mono>{s('colOwner')}</Mono>
          <Mono>{s('colEffective')}</Mono>
          <Mono>{s('colAffects')}</Mono>
        </div>
        {DECISIONS.map((d) => (
          <div
            key={d.id}
            className={cx('tm-hs-register__row', d.supersededBy && 'tm-hs-register__row--old')}
          >
            <span className="tm-hs-register__id">{d.id}</span>
            <span className="tm-hs-register__statement">
              {s(d.statement)}
              {d.supersededBy ? (
                <Pill tone="quiet">{s('supersededBy').replace('{id}', d.supersededBy)}</Pill>
              ) : null}
            </span>
            <span>{s(d.owner)}</span>
            <span className="tm-hs-register__date">{s(d.effective)}</span>
            <span className="tm-hs-register__affects">{d.affects ? s(d.affects) : '—'}</span>
          </div>
        ))}
      </div>
    </HomeScene>
  );
}

/* ── Control row: the audit log ──────────────────────────────────────────────── */

/** Row `n` reads `HomeScenes.auditWhen<n>` / `auditWhat<n>` / `auditNote<n>`. */
const AUDIT: readonly {
  n: number;
  id: string;
  kind: 'Client' | 'Content' | 'Policy';
  on?: boolean;
}[] = [
  { n: 1, id: 'EV·9C41', kind: 'Client', on: true },
  { n: 2, id: 'EV·9C38', kind: 'Content' },
  { n: 3, id: 'EV·9C11', kind: 'Policy' },
  { n: 4, id: 'EV·9BF7', kind: 'Client' },
  { n: 5, id: 'EV·9AC2', kind: 'Policy' },
  { n: 6, id: 'EV·9A80', kind: 'Content' },
  { n: 7, id: 'EV·9A31', kind: 'Policy' },
];

/** Label key, then the value's key — or `null` for a Latin value shown as is. */
const AUDIT_DETAIL: readonly (readonly [string, string, string | null])[] = [
  ['detailActor', 'detailActorValue', null],
  ['detailTarget', 'detailTargetValue', null],
  ['detailBefore', 'detailBeforeValue', null],
  ['detailAfter', 'detailAfterValue', null],
  ['detailDevice', 'detailDeviceValue', null],
  ['detailHash', '', 'a71b·0e94'],
];

function AuditScreen() {
  const s = useSceneT();
  return (
    <div className="tm-hs-screen tm-hs-audit">
      <div className="tm-hs-audit__bar">
        <span className="tm-hs-audit__mark" />
        <Mono>{s('auditBreadcrumb')}</Mono>
        <Pill>{s('last30Days')}</Pill>
        <Pill>{s('policyChanges')}</Pill>
        <Pill tone="ink">{s('exportSignedCsv')}</Pill>
      </div>
      <div className="tm-hs-audit__split">
        <div className="tm-hs-audit__main">
          <p className="tm-hs-audit__count">
            {s('eventsCount')} <span>{s('eventsBreakdown')}</span>
          </p>
          <div className="tm-hs-audit__table">
            <div className="tm-hs-audit__row tm-hs-audit__row--head">
              <Mono>{s('colWhen')}</Mono>
              <Mono>{s('colWhoWhat')}</Mono>
              <Mono>{s('colEvent')}</Mono>
              <Mono>{s('colClass')}</Mono>
            </div>
            {AUDIT.map((row) => (
              <div
                key={row.id}
                className={cx('tm-hs-audit__row', row.on && 'tm-hs-audit__row--on')}
              >
                <Mono>{s(`auditWhen${row.n}`)}</Mono>
                <span className="tm-hs-audit__what">
                  {s(`auditWhat${row.n}`)}
                  <span>{s(`auditNote${row.n}`)}</span>
                </span>
                <Mono>{row.id}</Mono>
                <Pill tone={row.kind === 'Client' ? 'client' : 'quiet'}>
                  {s(`kind${row.kind}`)}
                </Pill>
              </div>
            ))}
          </div>
        </div>
        <div className="tm-hs-audit__side">
          <Mono>{s('eventHeading')}</Mono>
          <span className="tm-hs-audit__side-title">{s('clientVisibilityDefault')}</span>
          <dl className="tm-hs-audit__kv">
            {AUDIT_DETAIL.map(([label, valueKey, literal]) => (
              <div key={label}>
                <dt>{s(label)}</dt>
                <dd>{literal ?? s(valueKey)}</dd>
              </div>
            ))}
          </dl>
          <span className="tm-hs-audit__note">{s('auditNote')}</span>
          <span className="tm-hs-choice">
            <Pill>{s('copyHash')}</Pill>
            <Pill>{s('openTarget')}</Pill>
          </span>
        </div>
      </div>
    </div>
  );
}

export function AuditLogScene() {
  const s = useSceneT();
  return (
    <HomeScene label={s('auditLogLabel')} className="tm-home-frame-scene">
      <div className="tm-hs-crop tm-hs-crop--start">
        <div className="tm-hs-fit tm-hs-fit--audit">
          <AuditScreen />
        </div>
      </div>
    </HomeScene>
  );
}
