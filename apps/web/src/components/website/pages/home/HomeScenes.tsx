'use client';

import type { ReactNode } from 'react';
import { StateCapsule } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import { WebIcon, type WebIconName } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Home-page product scenes (WEB-01 / WEB-18, Figma "T-Manage Website" round 2, frames 308:26 and
 * 308:43). The desktop scenes are scaled clones of real TManage screens — My Day (HOME-01), the
 * chat convert-to-work panel, the client portal overview, the decision register and the audit
 * log — cropped by their frame exactly as the design crops them. Each one is an illustration, so
 * the body is `inert` and hidden from assistive tech and one sentence of `label` stands in.
 * Seed data only: Northstar Studio, Atlas Hospitality, "Atlas Website Relaunch".
 */
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

const RAIL: readonly { label: string; icon: WebIconName; on?: boolean; count?: string }[] = [
  { label: 'My Day', icon: 'flag', on: true },
  { label: 'Inbox', icon: 'mail', count: '3' },
  { label: 'Chat', icon: 'chat' },
  { label: 'Work', icon: 'list' },
  { label: 'Docs', icon: 'doc' },
  { label: 'Files', icon: 'layers' },
  { label: 'Clients', icon: 'portal' },
  { label: 'Insights', icon: 'chart' },
  { label: 'Control', icon: 'shield' },
];

function AppRail() {
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
          <span className="tm-hs-rail__label">{item.label}</span>
        </span>
      ))}
    </div>
  );
}

function MyDayScreen() {
  return (
    <div className="tm-hs-screen tm-hs-myday">
      <AppRail />
      <div className="tm-hs-myday__main">
        <div className="tm-hs-strip">
          <span className="tm-hs-strip__today">
            <span className="tm-hs-strip__date">14</span>
            Today · Fri 14 Aug
          </span>
          <span className="tm-hs-strip__slot tm-hs-strip__slot--past">
            <Mono>09:30</Mono> Standup <WebIcon name="check" size={12} />
          </span>
          <span className="tm-hs-strip__slot tm-hs-strip__slot--now">
            <Mono>NOW 11:24</Mono> Atlas design review
            <span className="tm-hs-faces">
              <span>LS</span>
              <span>KN</span>
            </span>
          </span>
          <span className="tm-hs-strip__slot">
            <Mono>14:00</Mono> Client approval due
          </span>
          <span className="tm-hs-strip__slot">
            <Mono>16:00</Mono> Focus block
          </span>
        </div>

        <div className="tm-hs-myday__body">
          <div className="tm-hs-myday__col">
            <p className="tm-hs-meta">
              <span>NORTHSTAR STUDIO · CLIENT DELIVERY</span>
              <span className="tm-hs-meta__sep" />
              <span>11:24 · Cairo</span>
            </p>
            <div className="tm-hs-myday__head">
              <p className="tm-hs-myday__title">MY DAY</p>
              <span className="tm-hs-cta">
                <span className="tm-hs-cta__orb">
                  <WebIcon name="plus" size={12} />
                </span>
                New work
              </span>
              <div className="tm-hs-metrics">
                <span className="tm-hs-metric">
                  <span className="tm-hs-metric__value">04</span>
                  <Pill tone="lime" className="tm-hs-metric__tag">
                    on track
                  </Pill>
                  <span className="tm-hs-metric__label">days to Homepage direction</span>
                  <span className="tm-hs-metric__note">committed 18 Aug</span>
                </span>
                <span className="tm-hs-metric">
                  <span className="tm-hs-metric__value">26h</span>
                  <Pill tone="warn" className="tm-hs-metric__tag">
                    waiting
                  </Pill>
                  <span className="tm-hs-metric__label">longest client wait</span>
                  <span className="tm-hs-metric__note">Homepage Concept v2</span>
                </span>
                <span className="tm-hs-metric">
                  <span className="tm-hs-metric__value">3</span>
                  <Pill tone="danger" className="tm-hs-metric__tag">
                    up 2
                  </Pill>
                  <span className="tm-hs-metric__label">blocked commitments</span>
                  <span className="tm-hs-metric__note">2 wait on a client answer</span>
                </span>
              </div>
            </div>
            <p className="tm-hs-lede">
              Four things need you today. One of them is the only item blocking the Homepage
              direction milestone.
            </p>

            <div className="tm-hs-focus">
              <span className="tm-hs-focus__play">
                <WebIcon name="play" size={12} />
              </span>
              <span className="tm-hs-focus__text">
                <span className="tm-hs-focus__title">
                  Publish Homepage Concept v2 to Atlas Hospitality
                </span>
                <span className="tm-hs-focus__why">
                  Why now — Youssef reviews at 14:00 and 4 days remain on the committed milestone.
                </span>
              </span>
              <Pill tone="dim" icon="help">
                Client action required
              </Pill>
              <span className="tm-hs-focus__go">
                <WebIcon name="arrow-right" size={12} />
              </span>
            </div>

            <div className="tm-hs-row-head">
              <span className="tm-hs-row-head__title">Due &amp; at risk</span>
              <span className="tm-hs-row-head__count">7 items</span>
              <Pill tone="ink">Today</Pill>
              <Pill>Blocked · 3</Pill>
              <Pill>Client waiting · 2</Pill>
            </div>
            <div className="tm-hs-due">
              <div className="tm-hs-due__card tm-hs-due__card--lime">
                <span className="tm-hs-due__who">
                  <span className="tm-hs-face tm-hs-face--ink">OA</span>
                  Deliverable · you own it
                  <span className="tm-hs-due__open tm-hs-due__open--ink">
                    <WebIcon name="arrow-right" size={12} />
                  </span>
                </span>
                <span className="tm-hs-due__title">
                  Homepage Concept v2 — publish for client review
                </span>
                <span className="tm-hs-due__meta">committed 18 Aug · reviewer Youssef Kamal</span>
                <Pill tone="ink">Run safety check</Pill>
              </div>
              <div className="tm-hs-due__card">
                <span className="tm-hs-due__who">
                  <span className="tm-hs-face tm-hs-face--grey">LS</span>
                  Task · Lina Samir
                  <span className="tm-hs-due__open">
                    <WebIcon name="arrow-right" size={12} />
                  </span>
                </span>
                <span className="tm-hs-due__title">Prepare mobile booking flow concepts</span>
                <span className="tm-hs-due__meta">due 20 Aug · from #atlas-relaunch</span>
                <Pill tone="warn">
                  <Dot tone="warn" />
                  Blocked · waiting on brand assets
                </Pill>
              </div>
              <div className="tm-hs-due__card">
                <span className="tm-hs-due__who">
                  <span className="tm-hs-face tm-hs-face--client">SR</span>
                  Request · Salma Riad
                  <span className="tm-hs-due__open">
                    <WebIcon name="arrow-right" size={12} />
                  </span>
                </span>
                <span className="tm-hs-due__title">Add Arabic booking FAQ before launch</span>
                <span className="tm-hs-due__warn">not committed</span>
                <Pill tone="quiet">Needs triage · 2 days old</Pill>
              </div>
            </div>

            <div className="tm-hs-row-head">
              <span className="tm-hs-row-head__title">Waiting on others</span>
              <span className="tm-hs-row-head__count">
                nothing here needs you — it needs someone else
              </span>
            </div>
            <div className="tm-hs-waits">
              <span className="tm-hs-wait">
                <span className="tm-hs-face tm-hs-face--client">YK</span>
                <span className="tm-hs-wait__title">Approval · Homepage Concept v2</span>
                <span className="tm-hs-wait__state tm-hs-wait__state--warn">waiting 26h</span>
                <Mono>due 18 Aug</Mono>
                <Pill>Nudge</Pill>
              </span>
              <span className="tm-hs-wait">
                <span className="tm-hs-face tm-hs-face--ink">NF</span>
                <span className="tm-hs-wait__title">Migrate Arabic booking FAQ copy</span>
                <span className="tm-hs-wait__state">in progress</span>
                <Mono>forecast 8 Sep</Mono>
                <Pill>Open</Pill>
              </span>
              <span className="tm-hs-wait">
                <span className="tm-hs-face tm-hs-face--ink">MH</span>
                <span className="tm-hs-wait__title">Decision · Booking provider for phase 2</span>
                <span className="tm-hs-wait__state">draft</span>
                <Mono>no date</Mono>
                <Pill>Open</Pill>
              </span>
            </div>
          </div>

          <div className="tm-hs-lens">
            <Mono className="tm-hs-lens__label">Context lens</Mono>
            <span className="tm-hs-lens__title">Atlas Website Relaunch</span>
            <span className="tm-hs-lens__tags">
              <Pill tone="lime">Homepage direction</Pill>
              <span>committed 18 Aug</span>
            </span>
            <Mono className="tm-hs-lens__label">Work story · last 3 chapters</Mono>
            <ol className="tm-hs-lens__story">
              <li>
                <Mono>11:02 · Lina Samir</Mono>
                <span>v2 marked ready for client review</span>
              </li>
              <li>
                <Mono>09:48 · Internal review</Mono>
                <span>Maya approved 4 of 4 criteria</span>
                <span className="tm-hs-lens__note">brand, booking CTA, AR/EN parity, speed</span>
              </li>
              <li>
                <Mono>Yesterday 17:20 · #atlas</Mono>
                <span>Booking CTA wording agreed</span>
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
  const t = useT();
  return (
    <HomeScene label={t('HomeScenes.heroLabel')} className="tm-home-hero-scene">
      <div className="tm-home-hero-scene__wide">
        <div className="tm-hs-panel">
          <div className="tm-hs-fit tm-hs-fit--hero">
            <MyDayScreen />
          </div>
        </div>
        <div className="tm-hs-float tm-hs-float--client">
          <StateCapsule state="client">Client review</StateCapsule>
          <span className="tm-hs-float__text">Homepage Concept v2 · waiting for Youssef</span>
        </div>
        <div className="tm-hs-float tm-hs-float--approved">
          <span className="tm-hs-float__badge">Approved · v2 · 18 Aug</span>
        </div>
        <div className="tm-hs-float tm-hs-float--chat">
          <span className="tm-hs-float__face">JR</span>
          <span className="tm-hs-float__chat">
            <span className="tm-hs-float__ask">Can we add an Arabic FAQ before launch?</span>
            <span className="tm-hs-float__chip">
              <WebIcon name="arrow-right" size={14} />
              Request created
            </span>
          </span>
        </div>
      </div>

      <div className="tm-home-hero-scene__narrow">
        <div className="tm-hs-stack">
          <div className="tm-hs-stack__card tm-hs-stack__card--lime">
            <span className="tm-hs-stack__who">
              <span className="tm-hs-face tm-hs-face--ink">YK</span>
              Youssef Kamal · Atlas Hospitality
              <strong>OWES US · 26h</strong>
            </span>
            <span className="tm-hs-stack__title">Approval of Homepage Concept v2</span>
            <span className="tm-hs-stack__actions">
              <Pill tone="ink">Nudge</Pill>
              <Pill>Extend</Pill>
            </span>
          </div>
          <div className="tm-hs-stack__card">
            <span className="tm-hs-stack__who">
              <span className="tm-hs-face tm-hs-face--client">SR</span>
              Salma Riad · new request
              <Mono>We owe · 2d</Mono>
            </span>
            <span className="tm-hs-stack__title">Add Arabic booking FAQ before launch</span>
            <span className="tm-hs-stack__note">Desired 3 Sep · not committed. Needs triage.</span>
          </div>
          <div className="tm-hs-stack__card">
            <span className="tm-hs-stack__who">
              <span className="tm-hs-face tm-hs-face--client">RM</span>
              Rania Mostafa · Meridian Group
              <Mono>Owes us · 4d</Mono>
            </span>
            <span className="tm-hs-stack__title">Upload brand assets pack</span>
            <span className="tm-hs-stack__note tm-hs-stack__note--warn">
              This upload is blocking one internal commitment.
            </span>
          </div>
          <div className="tm-hs-stack__card tm-hs-stack__card--peek">
            <span className="tm-hs-stack__who">
              <span className="tm-hs-face tm-hs-face--client">SR</span>
              Salma Riad · question
              <Mono>We owe · 2d</Mono>
            </span>
          </div>
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Team row A: the chat convert-to-work panel ──────────────────────────────── */

export function ChatConvertScene() {
  const t = useT();
  return (
    <HomeScene label={t('HomeScenes.chatThreadLabel')} className="tm-home-frame-scene">
      <div className="tm-hs-wide-only tm-hs-crop tm-hs-crop--end">
        <div className="tm-hs-screen tm-hs-chat">
          <div className="tm-hs-chat__bar">
            <span className="tm-hs-chat__channel">
              <span className="tm-hs-chat__name">#atlas-relaunch</span>
              <span className="tm-hs-chat__members">
                Project channel · 5 internal, 2 client members
              </span>
            </span>
            <span className="tm-hs-visible">
              <span className="tm-hs-visible__ring" />
              Client visible — Atlas Hospitality reads this channel
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
                Project brief · Homepage direction decision <Mono>2 objects</Mono>
              </span>
              <div className="tm-hs-msg">
                <Mono>Lina Samir · 10:41</Mono>
                <p>
                  Concept v2 is ready. I kept the booking CTA above the fold on mobile and moved the
                  offers below the rooms grid.
                </p>
              </div>
              <div className="tm-hs-msg">
                <span className="tm-hs-msg__head">
                  Salma Riad <Pill tone="client">Client</Pill> <Mono>10:58</Mono>
                </span>
                <p>
                  Can we also see the mobile booking flow before launch? Our guests mostly book on
                  phones.
                </p>
                <Pill tone="lime">Converted to work</Pill>
              </div>
              <div className="tm-hs-msg tm-hs-msg--picked">
                <Mono>Omar Adel · 11:02 · selected message</Mono>
                <p>
                  Yes — Lina will prepare mobile booking flow concepts. I&apos;ll commit a date
                  after the direction is approved.
                </p>
                <span className="tm-hs-linked">
                  <span className="tm-hs-linked__text">
                    <span className="tm-hs-linked__title">
                      Prepare mobile booking flow concepts
                    </span>
                    <Mono>TSK · Lina Samir · due 20 Aug · internal</Mono>
                  </span>
                  <span className="tm-hs-linked__open">Open</span>
                </span>
              </div>
            </div>
            <div className="tm-hs-convert">
              <span className="tm-hs-convert__head">
                <Mono>Thread · Convert to work</Mono>
                <span className="tm-hs-tool">
                  <WebIcon name="close" size={12} />
                </span>
              </span>
              <span className="tm-hs-source">
                <span className="tm-hs-source__who">
                  <span className="tm-hs-face tm-hs-face--client">SR</span>
                  Source message · Salma Riad · 10:58
                </span>
                <span>
                  “Can we also see the mobile booking flow before launch? Our guests mostly book on
                  phones.”
                </span>
              </span>
              <span className="tm-hs-field">
                <span className="tm-hs-field__label">Work title</span>
                <span className="tm-hs-input tm-hs-input--focus">
                  Prepare mobile booking flow concepts
                </span>
              </span>
              <span className="tm-hs-fields">
                <span className="tm-hs-field">
                  <span className="tm-hs-field__label">Owner</span>
                  <span className="tm-hs-input">
                    <span className="tm-hs-face tm-hs-face--grey">LS</span>
                    Lina Samir
                  </span>
                </span>
                <span className="tm-hs-field">
                  <span className="tm-hs-field__label">Committed date</span>
                  <span className="tm-hs-input">20 Aug 2026</span>
                </span>
              </span>
              <span className="tm-hs-field">
                <span className="tm-hs-field__label">Audience</span>
                <span className="tm-hs-choice">
                  <Pill tone="ink">
                    <Dot tone="lime" />
                    Internal
                  </Pill>
                  <Pill>Client visible</Pill>
                </span>
              </span>
              <span className="tm-hs-alert">
                <span className="tm-hs-alert__icon">!</span>
                <span className="tm-hs-alert__text">
                  <span className="tm-hs-alert__title">Inherited access warning</span>
                  <span>
                    The source message is in a client-visible channel. This work item defaults to
                    internal — the client will not see it, and the request stays uncommitted until
                    you commit a date.
                  </span>
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
            <span className="tm-hs-chat-m__who">Youssef Kamal · Atlas Hospitality</span>
            Can we add an Arabic FAQ before launch?
          </span>
        </div>
        <span className="tm-hs-chat-m__chip">
          <WebIcon name="arrow-right" size={12} />
          Request created
        </span>
        <div className="tm-hs-chat-m__card">
          <span className="tm-hs-chat-m__head">
            <span className="tm-hs-chat-m__title">Arabic FAQ before launch</span>
            <StateCapsule state="current">New request</StateCapsule>
          </span>
          <span className="tm-hs-chat-m__meta">Atlas Website Relaunch · Request</span>
          <span className="tm-hs-chat-m__foot">
            <span className="tm-hs-face tm-hs-face--grey tm-hs-face--lg">MS</span>
            <Pill className="tm-hs-pill--lg">Open</Pill>
            <Pill tone="ink" className="tm-hs-pill--lg">
              Approve
            </Pill>
          </span>
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Team row B: My Day, framed ──────────────────────────────────────────────── */

export function MyDayScene() {
  const t = useT();
  return (
    <HomeScene label={t('HomeScenes.myDayLabel')} className="tm-home-frame-scene">
      <div className="tm-hs-crop tm-hs-crop--start">
        <div className="tm-hs-fit tm-hs-fit--row">
          <MyDayScreen />
        </div>
      </div>
    </HomeScene>
  );
}

/* ── Clients row and the portal spotlight: the client portal overview ───────── */

function PortalScreen() {
  return (
    <div className="tm-hs-screen tm-hs-portal">
      <div className="tm-hs-portal__bar">
        <span className="tm-hs-portal__org">
          <span className="tm-hs-rail__mark">T</span>
          <span className="tm-hs-portal__org-text">
            <span className="tm-hs-portal__org-name">Atlas Hospitality</span>
            <span>delivered by Northstar Studio</span>
          </span>
        </span>
        <span className="tm-hs-portal__nav">
          <Pill tone="ink">Overview</Pill>
          <span>My actions</span>
          <span>Timeline</span>
          <span>Deliverables</span>
          <span>Updates</span>
          <span>Files</span>
          <span>People</span>
        </span>
        <Pill className="tm-hs-portal__me">
          <span className="tm-hs-face tm-hs-face--client">SR</span>
          Salma Riad
        </Pill>
      </div>
      <div className="tm-hs-portal__body">
        <Mono>Your project · on track for the committed launch</Mono>
        <div className="tm-hs-portal__hero">
          <span className="tm-hs-portal__intro">
            <span className="tm-hs-portal__title">Website relaunch</span>
            <span className="tm-hs-lede">
              Everything is moving toward launch on 30 September. One decision from you is needed
              this week.
            </span>
          </span>
          <span className="tm-hs-metric">
            <span className="tm-hs-metric__value">47</span>
            <span className="tm-hs-metric__label">days to launch</span>
            <span className="tm-hs-metric__note">committed 30 Sep</span>
          </span>
          <span className="tm-hs-metric">
            <span className="tm-hs-metric__value">1</span>
            <Pill tone="lime" className="tm-hs-metric__tag">
              this week
            </Pill>
            <span className="tm-hs-metric__label">action waiting for you</span>
            <span className="tm-hs-metric__note">approval · about 10 minutes</span>
          </span>
        </div>
        <p className="tm-hs-meta">
          <Mono>Where the project is</Mono>
          <span>stage 2 of 5 · see the full timeline</span>
        </p>
        <div className="tm-hs-stages">
          <span className="tm-hs-stage tm-hs-stage--done">
            <WebIcon name="check" size={12} />
            <span className="tm-hs-stage__text">
              Discovery
              <Mono>done 28 Jul</Mono>
            </span>
          </span>
          <span className="tm-hs-stage tm-hs-stage--now">
            <span className="tm-hs-stage__text">
              <Mono>Now</Mono>
              Homepage direction
            </span>
            <span className="tm-hs-stage__wait">
              waiting for your approval
              <Mono>by 18 Aug</Mono>
            </span>
            <span className="tm-hs-face tm-hs-face--ink">YK</span>
          </span>
          <span className="tm-hs-stage">
            <span className="tm-hs-stage__text">
              Content migration
              <Mono>expected early Sep</Mono>
            </span>
          </span>
          <span className="tm-hs-stage">
            <span className="tm-hs-stage__text">
              Quality review
              <Mono>20 Sep</Mono>
            </span>
          </span>
        </div>
        <div className="tm-hs-portal__cols">
          <div className="tm-hs-portal__actions">
            <span className="tm-hs-portal__h">Your actions</span>
            <span className="tm-hs-action">
              <span className="tm-hs-action__meta">
                <Mono>Approval · about 10 minutes</Mono>
                <Pill tone="ink">Due 18 Aug</Pill>
              </span>
              <span className="tm-hs-action__title">Approve the homepage direction</span>
              <span className="tm-hs-action__body">
                Youssef Kamal is named as the reviewer. Approving this lets content migration start
                this week and keeps the launch date.
              </span>
              <span className="tm-hs-action__foot">
                <span className="tm-hs-cta">
                  <span className="tm-hs-cta__orb tm-hs-cta__orb--lime">
                    <WebIcon name="play" size={12} />
                  </span>
                  Open the review
                </span>
                <span className="tm-hs-link">Ask a question instead</span>
              </span>
            </span>
            <span className="tm-hs-ask">
              <span className="tm-hs-ask__icon">?</span>
              <span className="tm-hs-ask__text">
                <span className="tm-hs-ask__title">Answer one question about the Arabic FAQ</span>
                <span>Omar asked on 12 Aug whether the FAQ covers group bookings.</span>
              </span>
              <Pill>Reply</Pill>
            </span>
            <span className="tm-hs-ask tm-hs-ask--quiet">
              <span className="tm-hs-ask__icon">
                <WebIcon name="check" size={12} />
              </span>
              After that, nothing else is needed from you. We&apos;ll notify you when your review,
              file, or answer is needed.
            </span>
          </div>
          <div className="tm-hs-portal__side">
            <span className="tm-hs-side-card">
              <span className="tm-hs-portal__h">Latest update</span>
              <span className="tm-hs-quote">
                “Homepage direction is with your reviewer. Content migration starts the same week
                and we hold the launch date.”
              </span>
              <span className="tm-hs-source__who">
                <span className="tm-hs-face tm-hs-face--ink">OA</span>
                Omar Adel · your project manager
              </span>
            </span>
            <span className="tm-hs-side-card">
              <span className="tm-hs-portal__h">Deliverables</span>
              <span className="tm-hs-deliv">
                <span className="tm-hs-cta__orb tm-hs-cta__orb--lime">
                  <WebIcon name="play" size={12} />
                </span>
                <span className="tm-hs-deliv__text">
                  Homepage Concept v2
                  <Mono>Waiting for your approval</Mono>
                </span>
              </span>
              <span className="tm-hs-deliv">
                <span className="tm-hs-cta__orb tm-hs-cta__orb--outline">
                  <WebIcon name="check" size={12} />
                </span>
                <span className="tm-hs-deliv__text">
                  Discovery summary v3
                  <Mono>Approved 28 Jul · final</Mono>
                </span>
              </span>
            </span>
            <span className="tm-hs-side-card">
              <span className="tm-hs-portal__h">Your team at Northstar</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PortalScene({ variant = 'row' }: { variant?: 'row' | 'spotlight' }) {
  const t = useT();
  return (
    <HomeScene
      label={t('HomeScenes.portalLabel')}
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

const DECISIONS: readonly {
  id: string;
  statement: string;
  owner: string;
  effective: string;
  affects: string;
  superseded?: string;
}[] = [
  {
    id: 'DEC-115',
    statement: 'Offers strip moves below the rooms grid',
    owner: 'Lina Samir',
    effective: '14 Aug',
    affects: '3 items',
  },
  {
    id: 'DEC-114',
    statement: 'Booking CTA stays above the fold on mobile',
    owner: 'Omar Adel',
    effective: '14 Aug',
    affects: '6 items',
  },
  {
    id: 'DEC-109',
    statement: 'Launch commits to 30 September',
    owner: 'Omar Adel',
    effective: '22 Jul',
    affects: 'all work',
  },
  {
    id: 'DEC-104',
    statement: 'Arabic is in scope for phase one',
    owner: 'Maya Hassan',
    effective: '18 Jul',
    affects: '9 items',
  },
  {
    id: 'DEC-098',
    statement: 'Offers hero above the rooms grid',
    owner: 'Lina Samir',
    effective: '6 Aug',
    affects: '—',
    superseded: 'superseded by DEC-115',
  },
];

export function DecisionRegisterScene() {
  const t = useT();
  return (
    <HomeScene label={t('HomeScenes.decisionRegisterLabel')} className="tm-home-frame-scene">
      <div className="tm-hs-register">
        <div className="tm-hs-register__row tm-hs-register__row--head">
          <Mono>ID</Mono>
          <Mono>Statement</Mono>
          <Mono>Owner</Mono>
          <Mono>Effective</Mono>
          <Mono>Affects</Mono>
        </div>
        {DECISIONS.map((d) => (
          <div
            key={d.id}
            className={cx('tm-hs-register__row', d.superseded && 'tm-hs-register__row--old')}
          >
            <span className="tm-hs-register__id">{d.id}</span>
            <span className="tm-hs-register__statement">
              {d.statement}
              {d.superseded ? <Pill tone="quiet">{d.superseded}</Pill> : null}
            </span>
            <span>{d.owner}</span>
            <span className="tm-hs-register__date">{d.effective}</span>
            <span className="tm-hs-register__affects">{d.affects}</span>
          </div>
        ))}
      </div>
    </HomeScene>
  );
}

/* ── Control row: the audit log ──────────────────────────────────────────────── */

const AUDIT: readonly {
  when: string;
  what: string;
  note: string;
  id: string;
  kind: 'Client' | 'Content' | 'Policy';
  on?: boolean;
}[] = [
  {
    when: 'Today 09:40',
    what: 'Maya Hassan turned off “who did what” for Atlas Hospitality',
    note: 'client visibility default · was on since 4 Jul',
    id: 'EV·9C41',
    kind: 'Client',
    on: true,
  },
  {
    when: 'Today 08:02',
    what: 'Automation “Remind reviewer” notified Youssef Kamal',
    note: 'enabled by Maya Hassan · run RUN-4890',
    id: 'EV·9C38',
    kind: 'Content',
  },
  {
    when: 'Yest 16:12',
    what: 'Omar Adel added stage “Content migration” to Website relaunch',
    note: 'template edit · 9 seeded items',
    id: 'EV·9C11',
    kind: 'Policy',
  },
  {
    when: 'Yest 11:30',
    what: 'Youssef Kamal approved Homepage Concept v2',
    note: 'version 8f2c·d41a · signed from a trusted device',
    id: 'EV·9BF7',
    kind: 'Client',
  },
  {
    when: '13 Aug 10:04',
    what: 'Maya Hassan required two-factor for approval authority',
    note: 'security policy · affected 2 people',
    id: 'EV·9AC2',
    kind: 'Policy',
  },
  {
    when: '12 Aug 14:20',
    what: 'Omar Adel moved the Content migration forecast to 8 Sep',
    note: 'committed date 1 Sep unchanged · reason recorded',
    id: 'EV·9A80',
    kind: 'Content',
  },
  {
    when: '11 Aug 09:15',
    what: 'Maya Hassan set chat retention to 24 months',
    note: 'first deletion pass queued for 1 Sep',
    id: 'EV·9A31',
    kind: 'Policy',
  },
];

const AUDIT_DETAIL: readonly (readonly [string, string])[] = [
  ['Actor', 'Maya Hassan · Owner'],
  ['Target', 'Atlas Hospitality · portal'],
  ['Before', 'team attribution visible'],
  ['After', 'hidden from all client roles'],
  ['Device', 'macOS, Cairo · SSO session'],
  ['Hash', 'a71b·0e94'],
];

function AuditScreen() {
  return (
    <div className="tm-hs-screen tm-hs-audit">
      <div className="tm-hs-audit__bar">
        <span className="tm-hs-audit__mark" />
        <Mono>Control center / Audit log</Mono>
        <Pill>Last 30 days</Pill>
        <Pill>Policy changes</Pill>
        <Pill tone="ink">Export signed CSV</Pill>
      </div>
      <div className="tm-hs-audit__split">
        <div className="tm-hs-audit__main">
          <p className="tm-hs-audit__count">
            612 events <span>41 policy · 108 access · 463 content</span>
          </p>
          <div className="tm-hs-audit__table">
            <div className="tm-hs-audit__row tm-hs-audit__row--head">
              <Mono>When</Mono>
              <Mono>Who · what changed</Mono>
              <Mono>Event</Mono>
              <Mono>Class</Mono>
            </div>
            {AUDIT.map((row) => (
              <div
                key={row.id}
                className={cx('tm-hs-audit__row', row.on && 'tm-hs-audit__row--on')}
              >
                <Mono>{row.when}</Mono>
                <span className="tm-hs-audit__what">
                  {row.what}
                  <span>{row.note}</span>
                </span>
                <Mono>{row.id}</Mono>
                <Pill tone={row.kind === 'Client' ? 'client' : 'quiet'}>{row.kind}</Pill>
              </div>
            ))}
          </div>
        </div>
        <div className="tm-hs-audit__side">
          <Mono>Event EV·9C41</Mono>
          <span className="tm-hs-audit__side-title">Client visibility default</span>
          <dl className="tm-hs-audit__kv">
            {AUDIT_DETAIL.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <span className="tm-hs-audit__note">
            Audit entries cannot be edited by any owner. Exports are signed.
          </span>
          <span className="tm-hs-choice">
            <Pill>Copy hash</Pill>
            <Pill>Open the target</Pill>
          </span>
        </div>
      </div>
    </div>
  );
}

export function AuditLogScene() {
  const t = useT();
  return (
    <HomeScene label={t('HomeScenes.auditLogLabel')} className="tm-home-frame-scene">
      <div className="tm-hs-crop tm-hs-crop--start">
        <div className="tm-hs-fit tm-hs-fit--audit">
          <AuditScreen />
        </div>
      </div>
    </HomeScene>
  );
}
