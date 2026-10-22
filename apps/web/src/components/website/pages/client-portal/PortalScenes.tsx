'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, Button, StateCapsule, type CapsuleState } from '@tmanage/ui';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useT } from '../../../../lib/i18n/use-t';
import { WebIcon } from '../../WebIcon';
import { cx } from '../../primitives';

/**
 * Client-portal product scenes (WEB-07) — small, honest clones of the portal screens built from
 * packages/ui parts (StateCapsule, Badge, Avatar, Button) and Limeframe tokens. Like the shared
 * scenes they are illustrations: the body is `inert` and hidden from assistive tech, and `label`
 * carries one sentence of alternative text.
 *
 * Every visible string is a `PortalScenes.*` key (L4), so the scenes follow the active locale.
 * Company names (Atlas Hospitality, Northstar Studio), version tags and the portal URL stay
 * Latin. `ArabicPortalScene` is the deliberate exception: it is always Arabic, in either locale.
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

const STAGE_KEYS: readonly { label: MessageKey; state: Stage['state'] }[] = [
  { label: 'PortalScenes.stageDiscovery', state: 'done' },
  { label: 'PortalScenes.stageDesign', state: 'current' },
  { label: 'PortalScenes.stageBuild', state: 'future' },
  { label: 'PortalScenes.stageLaunch', state: 'future' },
];

/** The project's four stages in the active locale. */
function useStages(): readonly Stage[] {
  const t = useT();
  return STAGE_KEYS.map((stage) => ({ label: t(stage.label), state: stage.state }));
}

/** Portal overview (product §15/16): stage track, one number, the client's own actions. */
export function PortalOverviewScene() {
  const t = useT();
  const stages = useStages();
  return (
    <PortalScene label={t('PortalScenes.overviewLabel')} className="tm-cp-scene--overview">
      <div className="tm-cp-bar">
        <span className="tm-cp-url">atlas.tmanage.app/portal</span>
        <StateCapsule state="client">{t('PortalScenes.client')}</StateCapsule>
      </div>
      <div className="tm-cp-pad">
        <p className="tm-web-scene__mono">{t('PortalScenes.orgLine')}</p>
        <p className="tm-cp-title">{t('PortalScenes.projectTitle')}</p>
        <StageTrack stages={stages} />
        <div className="tm-cp-metric">
          <span className="tm-cp-metric__value">12</span>
          <span className="tm-cp-metric__text">
            <span className="tm-cp-metric__label">{t('PortalScenes.daysToLaunch')}</span>
            <span className="tm-cp-row__meta">{t('PortalScenes.launchMeta')}</span>
          </span>
        </div>
        <p className="tm-web-scene__mono tm-cp-heading">{t('PortalScenes.yourActions2')}</p>
        <div className="tm-cp-list">
          <ActionRow
            title={t('PortalScenes.reviewHomepageTitle')}
            meta={t('PortalScenes.requestedByMaya')}
            state="client"
            capsule={t('PortalScenes.capsuleYourReview')}
            action={t('PortalScenes.actionReview')}
          />
          <ActionRow
            title={t('PortalScenes.uploadPhotosTitle')}
            meta={t('PortalScenes.uploadPhotosMeta')}
            state="waiting"
            capsule={t('PortalScenes.capsuleDueIn4')}
          />
        </div>
        <div className="tm-cp-people">
          <span className="tm-cp-avatars">
            <Avatar name={t('PortalScenes.nameMaya')} size="compact" decorative />
            <Avatar name={t('PortalScenes.nameOmar')} size="compact" decorative />
            <Avatar
              name={t('PortalScenes.nameSalma')}
              size="compact"
              audience="client"
              decorative
            />
          </span>
          <span className="tm-cp-row__meta">{t('PortalScenes.updatedByMaya')}</span>
        </div>
      </div>
    </PortalScene>
  );
}

const CRITERIA: readonly MessageKey[] = [
  'PortalScenes.criterionBooking',
  'PortalScenes.criterionRooms',
  'PortalScenes.criterionBrief',
];

/** Client approval (product §13): one exact version, the criteria, earlier feedback. */
export function ApprovalScene() {
  const t = useT();
  return (
    <PortalScene label={t('PortalScenes.approvalLabel')} className="tm-cp-scene--approval">
      <div className="tm-cp-pad">
        <div className="tm-cp-head">
          <Badge mono>{t('PortalScenes.badgeDeliverable')}</Badge>
          <StateCapsule state="client">{t('PortalScenes.capsuleWaitingOnYou')}</StateCapsule>
        </div>
        <p className="tm-cp-title">{t('PortalScenes.homepageTitle')}</p>
        <p className="tm-cp-version">
          <span className="tm-cp-mono-chip">{t('PortalScenes.versionChip')}</span>
          <span className="tm-cp-row__meta">{t('PortalScenes.projectTitle')}</span>
        </p>
        <p className="tm-web-scene__mono tm-cp-heading">{t('PortalScenes.reviewCriteria')}</p>
        <ul className="tm-cp-checks">
          {CRITERIA.map((criterion) => (
            <li key={criterion}>
              <WebIcon name="check" size={14} />
              {t(criterion)}
            </li>
          ))}
        </ul>
        <div className="tm-cp-feedback">
          <Avatar
            name={t('PortalScenes.nameYoussef')}
            size="compact"
            audience="client"
            decorative
          />
          <span className="tm-cp-row__text">
            <span className="tm-cp-row__meta">{t('PortalScenes.feedbackMeta')}</span>
            <span className="tm-cp-feedback__text">{t('PortalScenes.feedbackQuote')}</span>
          </span>
        </div>
        <div className="tm-cp-actions">
          <Button tone="outline" size="feature">
            {t('PortalScenes.requestChanges')}
          </Button>
          <Button tone="ink" size="feature">
            {t('PortalScenes.approveV2')}
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
          <span className="tm-cp-title tm-cp-title--small">{t('PortalScenes.requestsTitle')}</span>
          <Button tone="ink" size="compact">
            {t('PortalScenes.newRequest')}
          </Button>
        </div>
        <span className="tm-cp-field">
          <WebIcon name="search" size={14} />
          {t('PortalScenes.requestPlaceholder')}
        </span>
        <div className="tm-cp-list">
          <div className="tm-cp-row">
            <span className="tm-cp-row__text">
              <span className="tm-cp-row__title">{t('PortalScenes.springOfferTitle')}</span>
              <span className="tm-cp-row__meta">
                <span className="tm-cp-mono-chip tm-cp-mono-chip--dashed">
                  {t('PortalScenes.wishChip')}
                </span>
                {t('PortalScenes.sentBySalma')}
              </span>
            </span>
            <StateCapsule state="waiting">{t('PortalScenes.capsuleUnderReview')}</StateCapsule>
          </div>
          <div className="tm-cp-row tm-cp-row--live">
            <span className="tm-cp-row__text">
              <span className="tm-cp-row__title">{t('PortalScenes.bookingWidgetTitle')}</span>
              <span className="tm-cp-row__meta">
                <span className="tm-cp-mono-chip">{t('PortalScenes.committedChip')}</span>
                {t('PortalScenes.ownerOmar')}
              </span>
            </span>
            <StateCapsule state="current">{t('PortalScenes.capsuleInProgress')}</StateCapsule>
          </div>
          <div className="tm-cp-row">
            <span className="tm-cp-row__text">
              <span className="tm-cp-row__title">{t('PortalScenes.menuPdfTitle')}</span>
              <span className="tm-cp-row__meta">{t('PortalScenes.menuPdfMeta')}</span>
            </span>
            <StateCapsule state="done">{t('PortalScenes.capsuleDelivered')}</StateCapsule>
          </div>
        </div>
      </div>
    </PortalScene>
  );
}

const SEATS: readonly { name: MessageKey; role: MessageKey }[] = [
  { name: 'PortalScenes.nameSalma', role: 'PortalScenes.roleSalma' },
  { name: 'PortalScenes.nameYoussef', role: 'PortalScenes.roleYoussef' },
];

/** Client members on the people screen — none of them uses a seat. */
export function ClientSeatsScene() {
  const t = useT();
  return (
    <PortalScene label={t('PortalScenes.seatsLabel')} className="tm-cp-scene--seats">
      <div className="tm-cp-pad">
        <div className="tm-cp-head">
          <span className="tm-cp-title tm-cp-title--small">{t('PortalScenes.seatsTitle')}</span>
          <Badge tone="client">{t('PortalScenes.client')}</Badge>
        </div>
        <div className="tm-cp-list">
          {SEATS.map((person) => (
            <div key={person.name} className="tm-cp-row">
              <Avatar name={t(person.name)} size="compact" audience="client" decorative />
              <span className="tm-cp-row__text">
                <span className="tm-cp-row__title">{t(person.name)}</span>
                <span className="tm-cp-row__meta">{t(person.role)}</span>
              </span>
              <span className="tm-cp-mono-chip">{t('PortalScenes.noSeat')}</span>
            </div>
          ))}
          <div className="tm-cp-row tm-cp-row--invite">
            <span className="tm-web-orb tm-web-orb--outline tm-web-orb--compact">
              <WebIcon name="plus" size={14} />
            </span>
            <span className="tm-cp-row__text">
              <span className="tm-cp-row__title">{t('PortalScenes.inviteTitle')}</span>
              <span className="tm-cp-row__meta">{t('PortalScenes.inviteMeta')}</span>
            </span>
          </div>
        </div>
        <p className="tm-cp-foot">
          <span className="tm-web-scene__mono">{t('PortalScenes.footTeamSeats')}</span>
          <span className="tm-web-scene__mono">{t('PortalScenes.footClientMembers')}</span>
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
  const stages = useStages();
  return (
    <Peek>
      <StageTrack stages={stages} />
    </Peek>
  );
}

export function MiniMetricPeek() {
  const t = useT();
  return (
    <Peek>
      <div className="tm-cp-metric tm-cp-metric--peek">
        <span className="tm-cp-metric__value">12</span>
        <span className="tm-cp-metric__text">
          <span className="tm-cp-metric__label">{t('PortalScenes.daysToLaunch')}</span>
          <span className="tm-cp-row__meta">{t('PortalScenes.launchMeta')}</span>
        </span>
      </div>
    </Peek>
  );
}

export function MiniActionPeek() {
  const t = useT();
  return (
    <Peek>
      <div className="tm-cp-list tm-cp-list--peek">
        <div className="tm-cp-row">
          <span className="tm-cp-row__text">
            <span className="tm-cp-row__title">{t('PortalScenes.peekHomepage')}</span>
            <span className="tm-cp-row__meta">{t('PortalScenes.peekDeliverableReview')}</span>
          </span>
          <StateCapsule state="client">{t('PortalScenes.capsuleYourReview')}</StateCapsule>
        </div>
        <div className="tm-cp-row">
          <span className="tm-cp-row__text">
            <span className="tm-cp-row__title">{t('PortalScenes.peekBrandPhotos')}</span>
            <span className="tm-cp-row__meta">{t('PortalScenes.peekFileRequest')}</span>
          </span>
          <StateCapsule state="waiting">{t('PortalScenes.capsuleDue')}</StateCapsule>
        </div>
      </div>
    </Peek>
  );
}

/** The CTA band's crop: the client's view of one project, with the one action they owe. */
export function PortalCtaScene() {
  const t = useT();
  const stages = useStages();
  return (
    <PortalScene label={t('PortalScenes.ctaLabel')} className="tm-cp-scene--cta">
      <div className="tm-cp-bar">
        <span className="tm-cp-url">atlas.tmanage.app/portal</span>
        <StateCapsule state="client">{t('PortalScenes.client')}</StateCapsule>
      </div>
      <div className="tm-cp-pad">
        <p className="tm-cp-title tm-cp-title--small">{t('PortalScenes.projectTitle')}</p>
        <StageTrack stages={stages} />
        <p className="tm-web-scene__mono tm-cp-heading">{t('PortalScenes.yourActions1')}</p>
        <div className="tm-cp-list">
          <ActionRow
            title={t('PortalScenes.homepageTitle')}
            meta={t('PortalScenes.requestedByMaya')}
            state="client"
            capsule={t('PortalScenes.capsuleYourReview')}
            action={t('PortalScenes.actionReview')}
          />
        </div>
      </div>
    </PortalScene>
  );
}
