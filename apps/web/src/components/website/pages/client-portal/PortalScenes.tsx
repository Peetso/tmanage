'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Client-portal product scenes (WEB-07) — small, honest clones of the portal screens built from
 * packages/ui parts (StateCapsule, Badge, Avatar, Button) and Limeframe tokens. Like the shared
 * scenes they are illustrations: the body is `inert` and hidden from assistive tech, and `label`
 * carries one sentence of alternative text.
 */
function PortalScene({
  label,
  className,
  lang,
  children,
}: {
  label: string;
  className?: string;
  lang?: 'ar';
  children: ReactNode;
}) {
  return (
    <figure className={cx('tm-web-scene', 'tm-cp-scene', className)}>
      <figcaption className="tm-visually-hidden">{label}</figcaption>
      <div
        className="tm-web-scene__body tm-cp-card"
        aria-hidden="true"
        inert
        {...(lang ? { lang, dir: 'rtl' } : {})}
      >
        {children}
      </div>
    </figure>
  );
}

interface Stage {
  label: string;
  state: 'done' | 'current' | 'future';
}

function StageTrack({ stages }: { stages: readonly Stage[] }) {
  return (
    <ol className="tm-cp-stages">
      {stages.map((stage) => (
        <li key={stage.label} className={cx('tm-cp-stage', `tm-cp-stage--${stage.state}`)}>
          <span className="tm-cp-stage__bar" />
          <span className="tm-cp-stage__label">
            {stage.state === 'done' ? <WebIcon name="check" size={12} /> : null}
            {stage.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface ActionRowProps {
  title: string;
  meta: string;
  state: CapsuleState;
  capsule: string;
  action?: string;
}

function ActionRow({ title, meta, state, capsule, action }: ActionRowProps) {
  return (
    <div className="tm-cp-row">
      <span className="tm-cp-row__text">
        <span className="tm-cp-row__title">{title}</span>
        <span className="tm-cp-row__meta">{meta}</span>
      </span>
      <StateCapsule state={state}>{capsule}</StateCapsule>
      {action ? (
        <Button tone="ink" size="compact" className="tm-cp-row__action">
          {action}
        </Button>
      ) : null}
    </div>
  );
}

const STAGES_EN: readonly Stage[] = [
  { label: 'Discovery', state: 'done' },
  { label: 'Design', state: 'current' },
  { label: 'Build', state: 'future' },
  { label: 'Launch', state: 'future' },
];

/** Portal overview (product §15/16): stage track, one number, the client's own actions. */
export function PortalOverviewScene() {
  const t = useT();
  return (
    <PortalScene label={t('PortalScenes.overviewLabel')} className="tm-cp-scene--overview">
      <div className="tm-cp-bar">
        <span className="tm-cp-url">atlas.tmanage.app/portal</span>
        <StateCapsule state="client">Client</StateCapsule>
      </div>
      <div className="tm-cp-pad">
        <p className="tm-web-scene__mono">Atlas Hospitality · Northstar Studio</p>
        <p className="tm-cp-title">Atlas Website Relaunch</p>
        <StageTrack stages={STAGES_EN} />
        <div className="tm-cp-metric">
          <span className="tm-cp-metric__value">12</span>
          <span className="tm-cp-metric__text">
            <span className="tm-cp-metric__label">days to launch</span>
            <span className="tm-cp-row__meta">Launch · 30 Sep · on track</span>
          </span>
        </div>
        <p className="tm-web-scene__mono tm-cp-heading">Your actions · 2</p>
        <div className="tm-cp-list">
          <ActionRow
            title="Review Homepage Concept v2"
            meta="Deliverable · requested by Maya Hassan"
            state="client"
            capsule="Your review"
            action="Review"
          />
          <ActionRow
            title="Upload brand photography"
            meta="File request · due 22 Sep"
            state="waiting"
            capsule="Due in 4 days"
          />
        </div>
        <div className="tm-cp-people">
          <span className="tm-cp-avatars">
            <Avatar name="Maya Hassan" size="compact" decorative />
            <Avatar name="Omar Adel" size="compact" decorative />
            <Avatar name="Salma Riad" size="compact" audience="client" decorative />
          </span>
          <span className="tm-cp-row__meta">Updated 26 min ago by Maya Hassan</span>
        </div>
      </div>
    </PortalScene>
  );
}

/** Client approval (product §13): one exact version, the criteria, earlier feedback. */
export function ApprovalScene() {
  const t = useT();
  return (
    <PortalScene label={t('PortalScenes.approvalLabel')} className="tm-cp-scene--approval">
      <div className="tm-cp-pad">
        <div className="tm-cp-head">
          <Badge mono>Deliverable</Badge>
          <StateCapsule state="client">Waiting on you</StateCapsule>
        </div>
        <p className="tm-cp-title">Homepage Concept v2</p>
        <p className="tm-cp-version">
          <span className="tm-cp-mono-chip">v2 · uploaded 19 Aug</span>
          <span className="tm-cp-row__meta">Atlas Website Relaunch</span>
        </p>
        <p className="tm-web-scene__mono tm-cp-heading">Review criteria</p>
        <ul className="tm-cp-checks">
          <li>
            <WebIcon name="check" size={14} />
            Booking call to action stays above the fold
          </li>
          <li>
            <WebIcon name="check" size={14} />
            Room grid shows prices before offers
          </li>
          <li>
            <WebIcon name="check" size={14} />
            Copy matches the approved brief
          </li>
        </ul>
        <div className="tm-cp-feedback">
          <Avatar name="Youssef Kamal" size="compact" audience="client" decorative />
          <span className="tm-cp-row__text">
            <span className="tm-cp-row__meta">Youssef Kamal on v1 · 12 Aug</span>
            <span className="tm-cp-feedback__text">“Move the offers strip below the rooms.”</span>
          </span>
        </div>
        <div className="tm-cp-actions">
          <Button tone="outline" size="feature">
            Request changes
          </Button>
          <Button tone="ink" size="feature">
            Approve v2
          </Button>
        </div>
      </div>
    </PortalScene>
  );
}

/** Client requests: each with a clear status; a desired date stays a wish until committed. */
export function RequestsScene() {
  const t = useT();
  return (
    <PortalScene label={t('PortalScenes.requestsLabel')} className="tm-cp-scene--requests">
      <div className="tm-cp-pad">
        <div className="tm-cp-head">
          <span className="tm-cp-title tm-cp-title--small">Requests</span>
          <Button tone="ink" size="compact">
            New request
          </Button>
        </div>
        <span className="tm-cp-field">
          <WebIcon name="search" size={14} />
          Ask Northstar for something…
        </span>
        <div className="tm-cp-list">
          <div className="tm-cp-row">
            <span className="tm-cp-row__text">
              <span className="tm-cp-row__title">Spring offer landing page</span>
              <span className="tm-cp-row__meta">
                <span className="tm-cp-mono-chip tm-cp-mono-chip--dashed">Wish · 15 Oct</span>
                Sent by Salma Riad
              </span>
            </span>
            <StateCapsule state="waiting">Under review</StateCapsule>
          </div>
          <div className="tm-cp-row tm-cp-row--live">
            <span className="tm-cp-row__text">
              <span className="tm-cp-row__title">Booking widget on mobile</span>
              <span className="tm-cp-row__meta">
                <span className="tm-cp-mono-chip">Committed · 9 Oct</span>
                Owner Omar Adel
              </span>
            </span>
            <StateCapsule state="current">In progress</StateCapsule>
          </div>
          <div className="tm-cp-row">
            <span className="tm-cp-row__text">
              <span className="tm-cp-row__title">Arabic restaurant menu PDF</span>
              <span className="tm-cp-row__meta">Delivered 2 Oct · 1 file</span>
            </span>
            <StateCapsule state="done">Delivered</StateCapsule>
          </div>
        </div>
      </div>
    </PortalScene>
  );
}

/** Client members on the people screen — none of them uses a seat. */
export function ClientSeatsScene() {
  const t = useT();
  return (
    <PortalScene label={t('PortalScenes.seatsLabel')} className="tm-cp-scene--seats">
      <div className="tm-cp-pad">
        <div className="tm-cp-head">
          <span className="tm-cp-title tm-cp-title--small">People · Atlas Hospitality</span>
          <Badge tone="client">Client</Badge>
        </div>
        <div className="tm-cp-list">
          {[
            { name: 'Salma Riad', role: 'Sponsor · approves milestones' },
            { name: 'Youssef Kamal', role: 'Reviewer · Homepage, Booking' },
          ].map((person) => (
            <div key={person.name} className="tm-cp-row">
              <Avatar name={person.name} size="compact" audience="client" decorative />
              <span className="tm-cp-row__text">
                <span className="tm-cp-row__title">{person.name}</span>
                <span className="tm-cp-row__meta">{person.role}</span>
              </span>
              <span className="tm-cp-mono-chip">No seat</span>
            </div>
          ))}
          <div className="tm-cp-row tm-cp-row--invite">
            <span className="tm-web-orb tm-web-orb--outline tm-web-orb--compact">
              <WebIcon name="plus" size={14} />
            </span>
            <span className="tm-cp-row__text">
              <span className="tm-cp-row__title">Invite a viewer</span>
              <span className="tm-cp-row__meta">Sees published updates and files</span>
            </span>
          </div>
        </div>
        <p className="tm-cp-foot">
          <span className="tm-web-scene__mono">Team seats · 5 of 5</span>
          <span className="tm-web-scene__mono">Client members · 2 · free</span>
        </p>
      </div>
    </PortalScene>
  );
}

const STAGES_AR: readonly Stage[] = [
  { label: 'الاستكشاف', state: 'done' },
  { label: 'التصميم', state: 'current' },
  { label: 'التنفيذ', state: 'future' },
  { label: 'الإطلاق', state: 'future' },
];

/** The same overview, in Arabic and mirrored right-to-left. */
export function ArabicPortalScene() {
  const t = useT();
  return (
    <PortalScene label={t('PortalScenes.arabicLabel')} className="tm-cp-scene--arabic" lang="ar">
      <div className="tm-cp-bar">
        <span className="tm-cp-url">atlas.tmanage.app/portal</span>
        <StateCapsule state="client">عميل</StateCapsule>
      </div>
      <div className="tm-cp-pad">
        <p className="tm-cp-kicker">أطلس للضيافة · نورث ستار ستوديو</p>
        <p className="tm-cp-title">إعادة إطلاق موقع أطلس</p>
        <StageTrack stages={STAGES_AR} />
        <div className="tm-cp-metric">
          <span className="tm-cp-metric__value">12</span>
          <span className="tm-cp-metric__text">
            <span className="tm-cp-metric__label">يوماً حتى الإطلاق</span>
            <span className="tm-cp-row__meta">الإطلاق · 30 سبتمبر · في الموعد</span>
          </span>
        </div>
        <div className="tm-cp-list">
          <ActionRow
            title="مراجعة تصميم الصفحة الرئيسية v2"
            meta="تسليم · طلبته مايا حسن"
            state="client"
            capsule="بانتظار مراجعتك"
            action="مراجعة"
          />
        </div>
      </div>
    </PortalScene>
  );
}

/**
 * Mini peeks for the "Thirty seconds" cards — one fragment of the portal per card, so each
 * card shows the thing it names. Decorative: the card's title and body carry the meaning.
 */
function Peek({ children }: { children: ReactNode }) {
  return (
    <div className="tm-cp-peek" aria-hidden="true" inert>
      {children}
    </div>
  );
}

export function MiniStagePeek() {
  return (
    <Peek>
      <StageTrack stages={STAGES_EN} />
    </Peek>
  );
}

export function MiniMetricPeek() {
  return (
    <Peek>
      <div className="tm-cp-metric tm-cp-metric--peek">
        <span className="tm-cp-metric__value">12</span>
        <span className="tm-cp-metric__text">
          <span className="tm-cp-metric__label">days to launch</span>
          <span className="tm-cp-row__meta">Launch · 30 Sep · on track</span>
        </span>
      </div>
    </Peek>
  );
}

export function MiniActionPeek() {
  return (
    <Peek>
      <div className="tm-cp-list tm-cp-list--peek">
        <div className="tm-cp-row">
          <span className="tm-cp-row__text">
            <span className="tm-cp-row__title">Homepage v2</span>
            <span className="tm-cp-row__meta">Deliverable · review</span>
          </span>
          <StateCapsule state="client">Your review</StateCapsule>
        </div>
        <div className="tm-cp-row">
          <span className="tm-cp-row__text">
            <span className="tm-cp-row__title">Brand photography</span>
            <span className="tm-cp-row__meta">File request · 22 Sep</span>
          </span>
          <StateCapsule state="waiting">Due</StateCapsule>
        </div>
      </div>
    </Peek>
  );
}

/** The CTA band's crop: the client's view of one project, with the one action they owe. */
export function PortalCtaScene() {
  const t = useT();
  return (
    <PortalScene label={t('PortalScenes.ctaLabel')} className="tm-cp-scene--cta">
      <div className="tm-cp-bar">
        <span className="tm-cp-url">atlas.tmanage.app/portal</span>
        <StateCapsule state="client">Client</StateCapsule>
      </div>
      <div className="tm-cp-pad">
        <p className="tm-cp-title tm-cp-title--small">Atlas Website Relaunch</p>
        <StageTrack stages={STAGES_EN} />
        <p className="tm-web-scene__mono tm-cp-heading">Your actions · 1</p>
        <div className="tm-cp-list">
          <ActionRow
            title="Homepage Concept v2"
            meta="Deliverable · requested by Maya Hassan"
            state="client"
            capsule="Your review"
            action="Review"
          />
        </div>
      </div>
    </PortalScene>
  );
}
