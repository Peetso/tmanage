'use client';

import Link from 'next/link';
import { Avatar, Badge, StateCapsule } from '@tmanage/ui';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ButtonLink,
  DeliveryRiskScene,
  FeatureRow,
  LogoStrip,
  SectionHeader,
  StatBand,
  WebIcon,
  WebSection,
  type LogoStripPartner,
  type StatProps,
  type WebIconName,
} from '../../index';
import { cx } from '../../primitives';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import {
  AuditLogScene,
  ChatConvertScene,
  DecisionRegisterScene,
  HeroScene,
  MyDayScene,
  PortalScene,
} from './HomeScenes';
import './home.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * WEB-01 Home (`/`) and WEB-18 Home on mobile — built to the round-2 Figma frames 308:26 (1440)
 * and 308:43 (390). Every word comes from the i18n catalog; every part is a shared website
 * component or a packages/ui component; page-only styling lives in `home.css` and reads Limeframe
 * tokens only.
 */

/** The Figma's plain section eyebrow: small uppercase sans, no dot (the dotted mono one is `Eyebrow`). */
function PlainEyebrow({
  children,
  tone = 'paper',
}: {
  children: ReactNode;
  tone?: 'paper' | 'lime';
}) {
  return (
    <p className={cx('tm-home-eyebrow', tone === 'lime' && 'tm-home-eyebrow--lime')}>{children}</p>
  );
}

/* ── 2. Hero ──────────────────────────────────────────────────────────────── */

function Hero() {
  const t = useT();
  return (
    <section className="tm-home-hero" aria-labelledby="home-hero-title">
      <div className="tm-web-container tm-home-hero__grid">
        <div className="tm-home-hero__copy">
          <PlainEyebrow>{t('HomePage.heroEyebrow')}</PlainEyebrow>
          <h1 id="home-hero-title" className="tm-home-hero__title">
            {t('HomePage.heroTitle')}
          </h1>
          <p className="tm-home-hero__lede">{t('HomePage.heroLede')}</p>
          <div className="tm-home-hero__actions">
            <ButtonLink href={SIGN_UP_HREF} tone="lime">
              {t('HomePage.startFree')}
            </ButtonLink>
            <ButtonLink href="/contact" tone="outline">
              {t('HomePage.bookDemo')}
            </ButtonLink>
          </div>
          <p className="tm-home-hero__micro">{t('HomePage.heroMicro')}</p>
        </div>
        <div className="tm-home-hero__visual">
          <HeroScene />
        </div>
      </div>
    </section>
  );
}

/* ── 4. Work-story band ───────────────────────────────────────────────────── */

const STORY_STEPS: readonly MessageKey[] = [
  'HomePage.stepRequest',
  'HomePage.stepClarify',
  'HomePage.stepCommit',
  'HomePage.stepPlan',
  'HomePage.stepReview',
  'HomePage.stepPublish',
  'HomePage.stepApprove',
  'HomePage.stepDeliver',
];
export const CURRENT_STEP = 4;

type StepState = 'done' | 'current' | 'future';

/** Where step `i` stands against the current step, and the mobile status word that says so. */
export function storyStepState(i: number): { state: StepState; statusKey: MessageKey } {
  if (i < CURRENT_STEP) return { state: 'done', statusKey: 'HomePage.trackDone' };
  if (i === CURRENT_STEP) return { state: 'current', statusKey: 'HomePage.trackInProgress' };
  return { state: 'future', statusKey: 'HomePage.trackNextWeek' };
}

function WorkStory() {
  const t = useT();
  return (
    <WebSection
      aria-labelledby="home-story-title"
      id="work-story"
      className="tm-home-story-section"
    >
      <SectionHeader
        id="home-story-title"
        align="center"
        eyebrow={t('HomePage.storyEyebrow')}
        title={t('HomePage.storyTitle')}
        lede={t('HomePage.storyLede')}
      />
      <div className="tm-home-track">
        <ol className="tm-home-track__list" aria-label={t('HomePage.storyStepsAria')}>
          {STORY_STEPS.map((step, i) => {
            const { state, statusKey } = storyStepState(i);
            return (
              <li
                key={step}
                className={cx('tm-home-track__step', `tm-home-track__step--${state}`)}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className="tm-home-track__n">{String(i + 1).padStart(2, '0')}</span>
                <StateCapsule state={state}>
                  <span className="tm-home-track__name">{t(step)}</span>
                  <span className="tm-home-track__status">{t(statusKey)}</span>
                </StateCapsule>
                {i < STORY_STEPS.length - 1 ? (
                  <span className="tm-home-track__arrow" aria-hidden="true">
                    <WebIcon name="arrow-right" size={14} />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
        <p className="tm-home-track__caption">{t('HomePage.storyCaption')}</p>
      </div>
    </WebSection>
  );
}

/* ── 5. Pillar tabs ───────────────────────────────────────────────────────── */

interface PillarRow {
  titleKey: MessageKey;
  bodyKey: MessageKey;
  link: { labelKey: MessageKey; href: string };
  visual: ReactNode;
}

const PILLARS: readonly { id: string; labelKey: MessageKey; rows: readonly PillarRow[] }[] = [
  {
    id: 'team',
    labelKey: 'HomePage.pillarTeam',
    rows: [
      {
        titleKey: 'HomePage.pillarTeamRow1Title',
        bodyKey: 'HomePage.pillarTeamRow1Body',
        link: { labelKey: 'HomePage.pillarTeamRow1Link', href: '/features/communication' },
        visual: <ChatConvertScene />,
      },
      {
        titleKey: 'HomePage.pillarTeamRow2Title',
        bodyKey: 'HomePage.pillarTeamRow2Body',
        link: { labelKey: 'HomePage.pillarTeamRow2Link', href: '/product#focus-space' },
        visual: <MyDayScene />,
      },
    ],
  },
  {
    id: 'clients',
    labelKey: 'HomePage.pillarClients',
    rows: [
      {
        titleKey: 'HomePage.pillarClientsRow1Title',
        bodyKey: 'HomePage.pillarClientsRow1Body',
        link: { labelKey: 'HomePage.pillarClientsRow1Link', href: '/client-portal' },
        visual: <PortalScene />,
      },
    ],
  },
  {
    id: 'knowledge',
    labelKey: 'HomePage.pillarKnowledge',
    rows: [
      {
        titleKey: 'HomePage.pillarKnowledgeRow1Title',
        bodyKey: 'HomePage.pillarKnowledgeRow1Body',
        link: { labelKey: 'HomePage.pillarKnowledgeRow1Link', href: '/features/knowledge' },
        visual: <DecisionRegisterScene />,
      },
    ],
  },
  {
    id: 'control',
    labelKey: 'HomePage.pillarControl',
    rows: [
      {
        titleKey: 'HomePage.pillarControlRow1Title',
        bodyKey: 'HomePage.pillarControlRow1Body',
        link: { labelKey: 'HomePage.pillarControlRow1Link', href: '/security' },
        visual: <AuditLogScene />,
      },
    ],
  },
];

/** The tab a roving-focus key moves to; ArrowRight is "next" in LTR and "previous" in RTL. */
export function nextPillarIndex(
  key: string,
  active: number,
  count: number,
  rtl: boolean,
): number | null {
  const last = count - 1;
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = rtl ? 'ArrowRight' : 'ArrowLeft';
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  if (key === forward) return active === last ? 0 : active + 1;
  if (key === back) return active === 0 ? last : active - 1;
  return null;
}

export function PillarTabs() {
  const t = useT();
  const base = useId();
  const [active, setActive] = useState(0);
  const tabId = (i: number) => `${base}-tab-${i}`;
  const panelId = (i: number) => `${base}-panel-${i}`;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const next = nextPillarIndex(event.key, active, PILLARS.length, rtl);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <WebSection aria-labelledby="home-pillars-title" className="tm-home-pillars">
      <h2 id="home-pillars-title" className="tm-visually-hidden">
        {t('HomePage.pillarsHeading')}
      </h2>
      <div className="tm-home-tabs">
        <div
          className="tm-home-tabs__list"
          role="tablist"
          aria-label={t('HomePage.pillarsTablistAria')}
        >
          {PILLARS.map((pillar, i) => (
            <button
              key={pillar.id}
              id={tabId(i)}
              type="button"
              role="tab"
              className="tm-home-tabs__tab"
              aria-selected={i === active}
              aria-controls={panelId(i)}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              onKeyDown={onKeyDown}
            >
              {t(pillar.labelKey)}
            </button>
          ))}
        </div>
      </div>
      {PILLARS.map((pillar, i) => (
        <div
          key={pillar.id}
          id={panelId(i)}
          role="tabpanel"
          aria-labelledby={tabId(i)}
          hidden={i !== active}
          className="tm-home-tabs__panel"
        >
          {pillar.rows.map((row, r) => (
            <FeatureRow
              key={row.titleKey}
              label={t(pillar.labelKey)}
              title={t(row.titleKey)}
              body={t(row.bodyKey)}
              link={{ label: t(row.link.labelKey), href: row.link.href }}
              visual={row.visual}
              reverse={r % 2 === 1}
            />
          ))}
        </div>
      ))}
    </WebSection>
  );
}

/* ── 6. Stats band ────────────────────────────────────────────────────────── */

function Stats() {
  const t = useT();
  const stats: readonly StatProps[] = [
    {
      value: '1',
      unit: t('HomePage.statVersionUnit'),
      label: t('HomePage.statVersionLabel'),
      note: t('HomePage.statVersionNote'),
    },
    {
      value: '3',
      unit: t('HomePage.statDatesUnit'),
      label: t('HomePage.statDatesLabel'),
      note: t('HomePage.statDatesNote'),
    },
    {
      value: '0',
      unit: t('HomePage.statCommentsUnit'),
      label: t('HomePage.statCommentsLabel'),
      note: t('HomePage.statCommentsNote'),
    },
    {
      value: '2',
      unit: t('HomePage.statLanguagesUnit'),
      label: t('HomePage.statLanguagesLabel'),
      note: t('HomePage.statLanguagesNote'),
    },
  ];
  return (
    <WebSection
      tone="sunken"
      spacing="compact"
      aria-labelledby="home-stats-title"
      className="tm-home-stats"
    >
      <h2 id="home-stats-title" className="tm-visually-hidden">
        {t('HomePage.statsHeading')}
      </h2>
      <StatBand stats={stats} />
      <p className="tm-home-stats__foot">{t('HomePage.statsFoot')}</p>
    </WebSection>
  );
}

/* ── 7. Who it's for ──────────────────────────────────────────────────────── */

const AUDIENCES: readonly { titleKey: MessageKey; bodyKey: MessageKey; href: string }[] = [
  {
    titleKey: 'HomePage.audienceAgenciesTitle',
    bodyKey: 'HomePage.audienceAgenciesBody',
    href: '/solutions/agencies',
  },
  {
    titleKey: 'HomePage.audienceConsultanciesTitle',
    bodyKey: 'HomePage.audienceConsultanciesBody',
    href: '/solutions/consultancies',
  },
  {
    titleKey: 'HomePage.audienceInhouseTitle',
    bodyKey: 'HomePage.audienceInhouseBody',
    href: '/solutions/in-house',
  },
];

function WhoItsFor() {
  const t = useT();
  return (
    <WebSection aria-labelledby="home-who-title" className="tm-home-who">
      <PlainEyebrow>{t('HomePage.whoEyebrow')}</PlainEyebrow>
      <h2 id="home-who-title" className="tm-visually-hidden">
        {t('HomePage.whoTitle')}
      </h2>
      <ul className="tm-home-cards tm-home-cards--3">
        {AUDIENCES.map((a) => (
          <li key={a.href}>
            <Link href={a.href} className="tm-home-card tm-home-card--audience">
              <span className="tm-home-card__title">{t(a.titleKey)}</span>
              <span className="tm-home-card__body">{t(a.bodyKey)}</span>
              <span className="tm-web-orb tm-web-orb--outline tm-web-orb--default tm-home-card__go">
                <WebIcon name="arrow-right" size={14} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </WebSection>
  );
}

/* ── 8. Client portal spotlight ───────────────────────────────────────────── */

const PORTAL_POINTS: readonly MessageKey[] = [
  'HomePage.portalPoint1',
  'HomePage.portalPoint2',
  'HomePage.portalPoint3',
];

function PortalSpotlight() {
  const t = useT();
  return (
    <WebSection
      spacing="flush"
      aria-labelledby="home-portal-title"
      className="tm-home-spot-section"
    >
      <div className="tm-home-spot">
        <div className="tm-home-spot__text">
          <PlainEyebrow tone="lime">{t('HomePage.portalEyebrow')}</PlainEyebrow>
          <h2 id="home-portal-title" className="tm-home-spot__title">
            {t('HomePage.portalTitle')}
          </h2>
          <ul className="tm-home-spot__points">
            {PORTAL_POINTS.map((point) => (
              <li key={point}>
                <span className="tm-home-spot__check" aria-hidden="true">
                  <WebIcon name="check" size={16} />
                </span>
                <span>{t(point)}</span>
              </li>
            ))}
          </ul>
          <ButtonLink href="/client-portal" tone="lime">
            {t('HomePage.portalCta')}
          </ButtonLink>
        </div>
        <div className="tm-home-spot__visual">
          <PortalScene variant="spotlight" />
        </div>
      </div>
    </WebSection>
  );
}

/* ── 9. Design-partner stories ────────────────────────────────────────────── */

const STORIES: readonly {
  quoteKey: MessageKey;
  authorKey: MessageKey;
  teamKey: MessageKey;
  orgKey: MessageKey;
  icon: WebIconName;
}[] = [
  {
    quoteKey: 'HomePage.story1Quote',
    authorKey: 'HomePage.story1Author',
    teamKey: 'HomePage.story1Team',
    orgKey: 'HomePage.story1Org',
    icon: 'grid',
  },
  {
    quoteKey: 'HomePage.story2Quote',
    authorKey: 'HomePage.story2Author',
    teamKey: 'HomePage.story2Team',
    orgKey: 'HomePage.story2Org',
    icon: 'briefcase',
  },
  {
    quoteKey: 'HomePage.story3Quote',
    authorKey: 'HomePage.story3Author',
    teamKey: 'HomePage.story3Team',
    orgKey: 'HomePage.story3Org',
    icon: 'building',
  },
];

function Stories() {
  const t = useT();
  return (
    <WebSection aria-labelledby="home-stories-title" className="tm-home-stories">
      <SectionHeader
        id="home-stories-title"
        eyebrow={t('HomePage.storiesEyebrow')}
        title={t('HomePage.storiesTitle')}
      />
      <ul className="tm-home-cards tm-home-cards--3 tm-home-stories__list">
        {STORIES.map((s) => (
          <li key={s.quoteKey}>
            <figure className="tm-web-quote tm-home-story-card">
              <span className="tm-home-story-card__logo">
                <WebIcon name={s.icon} size={14} />
                <span className="tm-home-story-card__team">{t(s.teamKey)}</span>
              </span>
              <blockquote className="tm-web-quote__text">
                <p>“{t(s.quoteKey)}”</p>
              </blockquote>
              <figcaption className="tm-web-quote__by">
                <Avatar name={t(s.authorKey)} decorative className="tm-home-story-card__avatar" />
                <span className="tm-web-quote__who">
                  <span className="tm-web-quote__role">{t(s.authorKey)}</span>
                  <span className="tm-web-quote__org">{t(s.orgKey)}</span>
                </span>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
      <div className="tm-home-stories__dots" aria-hidden="true">
        <span className="tm-home-stories__dot tm-home-stories__dot--on" />
        <span className="tm-home-stories__dot" />
        <span className="tm-home-stories__dot" />
      </div>
    </WebSection>
  );
}

/* ── 10. Resources row ────────────────────────────────────────────────────── */

/** Each card opens the place on the site where that item lives today. */
const RESOURCES: readonly {
  kindKey: MessageKey;
  titleKey: MessageKey;
  actionKey: MessageKey;
  href: string;
}[] = [
  {
    kindKey: 'HomePage.resourceGuideKind',
    titleKey: 'HomePage.resourceGuideTitle',
    actionKey: 'HomePage.resourceGuideAction',
    href: '/resources#res-feat-title',
  },
  {
    kindKey: 'HomePage.resourceTemplateKind',
    titleKey: 'HomePage.resourceTemplateTitle',
    actionKey: 'HomePage.resourceTemplateAction',
    href: '/features/work#templates',
  },
  {
    kindKey: 'HomePage.resourceBlogKind',
    titleKey: 'HomePage.resourceBlogTitle',
    actionKey: 'HomePage.resourceBlogAction',
    href: '/resources#res-library',
  },
  {
    kindKey: 'HomePage.resourceWalkthroughKind',
    titleKey: 'HomePage.resourceWalkthroughTitle',
    actionKey: 'HomePage.resourceWalkthroughAction',
    href: '/features/work#requests',
  },
];

function Resources() {
  const t = useT();
  return (
    <WebSection aria-labelledby="home-resources-title" className="tm-home-resources">
      <div className="tm-home-resources__head">
        <div className="tm-home-resources__title">
          <PlainEyebrow>{t('HomePage.resourcesEyebrow')}</PlainEyebrow>
          <h2 id="home-resources-title" className="tm-web-header__title">
            {t('HomePage.resourcesTitleModel')}
          </h2>
        </div>
        <Link href="/resources" className="tm-home-resources__all">
          {t('HomePage.resourcesLink')}
          <WebIcon name="arrow-right" size={14} />
        </Link>
      </div>
      <ul className="tm-home-cards tm-home-cards--4 tm-home-resources__list">
        {RESOURCES.map((r) => (
          <li key={r.titleKey}>
            <Link href={r.href} className="tm-home-card tm-home-card--resource">
              <span className="tm-home-card__thumb" aria-hidden="true" />
              <Badge mono>{t(r.kindKey).toUpperCase()}</Badge>
              <span className="tm-home-card__title">{t(r.titleKey)}</span>
              <span className="tm-home-card__action">
                {t(r.actionKey)}
                <WebIcon name="arrow-right" size={14} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </WebSection>
  );
}

/* ── 3. Logo strip: the kinds of teams in the design-partner programme ─────── */

/** Logo-strip partners as drawn: "Design partner 01…06", each with its kind of team. */
const PARTNER_TEAMS: readonly { kindKey: MessageKey; icon: WebIconName }[] = [
  { kindKey: 'HomePage.story1Team', icon: 'building' },
  { kindKey: 'HomePage.partnerDesignStudio', icon: 'pencil' },
  { kindKey: 'HomePage.partnerConsultancy', icon: 'briefcase' },
  { kindKey: 'HomePage.partnerInhouse', icon: 'person' },
  { kindKey: 'HomePage.story1Team', icon: 'layers' },
  { kindKey: 'HomePage.partnerConsultancy', icon: 'trend' },
];

/* ── 11. CTA band ─────────────────────────────────────────────────────────────
 * Web/CTA band markup with the spec's "Outline on ink" demo button (the same plain outline
 * button the hero uses) and the Delivery risk view shown whole (see home.css). */

function HomeCta() {
  const t = useT();
  return (
    <section className="tm-web-cta-section tm-home-cta" aria-labelledby="home-cta-title">
      <div className="tm-web-container">
        <div className="tm-web-cta">
          <div className="tm-web-cta__text">
            <h2 id="home-cta-title" className="tm-web-cta__title">
              {t('HomePage.ctaTitle')}
            </h2>
            <p className="tm-web-cta__lede">{t('HomePage.ctaLede')}</p>
            <div className="tm-web-cta__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('HomePage.startFree')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline-ink">
                {t('HomePage.bookDemo')}
              </ButtonLink>
            </div>
            <p className="tm-web-cta__note">{t('HomePage.ctaNote')}</p>
          </div>
          <div className="tm-web-cta__visual">
            <DeliveryRiskScene />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── The page ─────────────────────────────────────────────────────────────── */

export function HomePage() {
  const t = useT();
  const partners: readonly LogoStripPartner[] = PARTNER_TEAMS.map((team, i) => ({
    name: `${t('HomePage.partnerKind')} ${String(i + 1).padStart(2, '0')}`,
    kind: t(team.kindKey),
    icon: team.icon,
  }));
  return (
    <div className="tm-home">
      <Hero />
      <WebSection spacing="flush" className="tm-home-logos">
        <LogoStrip variant="detailed" partners={partners} />
      </WebSection>
      <WorkStory />
      <PillarTabs />
      <Stats />
      <WhoItsFor />
      <PortalSpotlight />
      <Stories />
      <Resources />
      <HomeCta />
    </div>
  );
}
