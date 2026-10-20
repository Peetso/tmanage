'use client';

import Link from 'next/link';
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Avatar, Badge, StateCapsule } from '@tmanage/ui';
import {
  ButtonLink,
  DeliveryRiskScene,
  Eyebrow,
  FeatureRow,
  IconOrb,
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
  AccessScene,
  ChatThreadScene,
  DecisionScene,
  HeroStoryScene,
  MyDayScene,
  PortalScene,
} from './HomeScenes';
import './home.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * WEB-01 Home (`/`). Every word comes from SITE-SPEC.md "PAGE: Home"; every part is a shared
 * website component or a packages/ui component; page-only styling lives in `home.css` and reads
 * Limeframe tokens only.
 */

/* ── 2. Hero ──────────────────────────────────────────────────────────────── */

function Hero() {
  const t = useT();
  return (
    <section className="tm-home-hero" aria-labelledby="home-hero-title">
      <div className="tm-web-container tm-home-hero__grid">
        <div className="tm-home-hero__copy">
          <Eyebrow>{t('HomePage.heroEyebrow')}</Eyebrow>
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
          <HeroStoryScene />
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
const CURRENT_STEP = 4;

function WorkStory() {
  const t = useT();
  return (
    <WebSection aria-labelledby="home-story-title" id="work-story">
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
            const state = i < CURRENT_STEP ? 'done' : i === CURRENT_STEP ? 'current' : 'future';
            return (
              <li
                key={step}
                className={cx('tm-home-track__step', `tm-home-track__step--${state}`)}
                aria-current={i === CURRENT_STEP ? 'step' : undefined}
              >
                <span className="tm-home-track__n">{String(i + 1).padStart(2, '0')}</span>
                <StateCapsule state={state}>{t(step)}</StateCapsule>
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
        visual: <ChatThreadScene />,
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
        visual: <DecisionScene />,
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
        visual: <AccessScene />,
      },
    ],
  },
];

function PillarTabs() {
  const t = useT();
  const base = useId();
  const [active, setActive] = useState(0);
  const tabId = (i: number) => `${base}-tab-${i}`;
  const panelId = (i: number) => `${base}-panel-${i}`;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const last = PILLARS.length - 1;
    let next = active;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === forward) next = active === last ? 0 : active + 1;
    else next = active === 0 ? last : active - 1;
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
          className="tm-segmented tm-home-tabs__list"
          role="tablist"
          aria-label={t('HomePage.pillarsTablistAria')}
        >
          {PILLARS.map((pillar, i) => (
            <button
              key={pillar.id}
              id={tabId(i)}
              type="button"
              role="tab"
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
      <p className="tm-home-stats__foot">
        <span className="tm-web-eyebrow__dot" aria-hidden="true" />
        <span className="tm-web-scene__mono">{t('HomePage.statsFoot')}</span>
      </p>
    </WebSection>
  );
}

/* ── 7. Who it's for ──────────────────────────────────────────────────────── */

const AUDIENCES: readonly {
  titleKey: MessageKey;
  bodyKey: MessageKey;
  href: string;
  icon: WebIconName;
}[] = [
  {
    titleKey: 'HomePage.audienceAgenciesTitle',
    bodyKey: 'HomePage.audienceAgenciesBody',
    href: '/solutions/agencies',
    icon: 'grid',
  },
  {
    titleKey: 'HomePage.audienceConsultanciesTitle',
    bodyKey: 'HomePage.audienceConsultanciesBody',
    href: '/solutions/consultancies',
    icon: 'briefcase',
  },
  {
    titleKey: 'HomePage.audienceInhouseTitle',
    bodyKey: 'HomePage.audienceInhouseBody',
    href: '/solutions/in-house',
    icon: 'building',
  },
];

function WhoItsFor() {
  const t = useT();
  return (
    <WebSection aria-labelledby="home-who-title" className="tm-home-who">
      <SectionHeader
        id="home-who-title"
        eyebrow={t('HomePage.whoEyebrow')}
        title={t('HomePage.whoTitle')}
      />
      <ul className="tm-home-cards tm-home-cards--3">
        {AUDIENCES.map((a) => (
          <li key={a.href}>
            <Link href={a.href} className="tm-home-card">
              <IconOrb icon={a.icon} tone="lime" />
              <span className="tm-home-card__title">{t(a.titleKey)}</span>
              <span className="tm-home-card__body">{t(a.bodyKey)}</span>
              <span className="tm-home-card__foot">
                <span className="tm-home-card__more">{t('HomePage.seeSolution')}</span>
                <span className="tm-web-orb tm-web-orb--outline tm-web-orb--default">
                  <WebIcon name="arrow-right" size={14} />
                </span>
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
          <Eyebrow tone="ink">{t('HomePage.portalEyebrow')}</Eyebrow>
          <h2 id="home-portal-title" className="tm-home-spot__title">
            {t('HomePage.portalTitle')}
          </h2>
          <ul className="tm-home-spot__points">
            {PORTAL_POINTS.map((point) => (
              <li key={point}>
                <IconOrb icon="check" tone="lime" size="compact" />
                <span>{t(point)}</span>
              </li>
            ))}
          </ul>
          <ButtonLink href="/client-portal" tone="lime">
            {t('HomePage.portalCta')}
          </ButtonLink>
        </div>
        <div className="tm-home-spot__visual">
          <PortalScene />
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
        {STORIES.map((s, i) => (
          <li key={s.quoteKey}>
            <figure
              className={cx('tm-web-quote', 'tm-home-story-card', i === 1 && 'tm-web-quote--ink')}
            >
              <span className="tm-home-story-card__logo">
                <IconOrb icon={s.icon} tone="lime" size="compact" />
                <span className="tm-home-story-card__team">{t(s.teamKey)}</span>
              </span>
              <blockquote className="tm-web-quote__text">
                <p>“{t(s.quoteKey)}”</p>
              </blockquote>
              <figcaption className="tm-web-quote__by">
                <Avatar name={t(s.authorKey)} audience="client" decorative />
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
  metaKey: MessageKey;
  icon: WebIconName;
  href: string;
}[] = [
  {
    kindKey: 'HomePage.resourceGuideKind',
    titleKey: 'HomePage.resourceGuideTitle',
    metaKey: 'HomePage.resourceGuideMeta',
    icon: 'book',
    href: '/resources#res-feat-title',
  },
  {
    kindKey: 'HomePage.resourceTemplateKind',
    titleKey: 'HomePage.resourceTemplateTitle',
    metaKey: 'HomePage.resourceTemplateMeta',
    icon: 'layers',
    href: '/features/work#templates',
  },
  {
    kindKey: 'HomePage.resourceBlogKind',
    titleKey: 'HomePage.resourceBlogTitle',
    metaKey: 'HomePage.resourceBlogMeta',
    icon: 'pencil',
    href: '/resources#res-library',
  },
  {
    kindKey: 'HomePage.resourceWalkthroughKind',
    titleKey: 'HomePage.resourceWalkthroughTitle',
    metaKey: 'HomePage.resourceWalkthroughMeta',
    icon: 'video',
    href: '/features/work#requests',
  },
];

function Resources() {
  const t = useT();
  return (
    <WebSection aria-labelledby="home-resources-title" className="tm-home-resources">
      <SectionHeader
        id="home-resources-title"
        eyebrow={t('HomePage.resourcesEyebrow')}
        title={t('HomePage.resourcesTitle')}
        link={{ label: t('HomePage.resourcesLink'), href: '/resources' }}
      />
      <ul className="tm-home-cards tm-home-cards--4">
        {RESOURCES.map((r) => (
          <li key={r.titleKey}>
            <Link href={r.href} className="tm-home-card tm-home-card--resource">
              <span className="tm-home-card__top">
                <Badge mono>{t(r.kindKey).toUpperCase()}</Badge>
                <IconOrb icon={r.icon} tone="tint" size="compact" />
              </span>
              <span className="tm-home-card__title">{t(r.titleKey)}</span>
              <span className="tm-home-card__foot">
                <span className="tm-home-card__more">{t(r.metaKey)}</span>
                <span className="tm-web-orb tm-web-orb--outline tm-web-orb--default">
                  <WebIcon name="arrow-right" size={14} />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </WebSection>
  );
}

/* ── 3. Logo strip: the kinds of teams in the design-partner programme ─────── */

/** Logo-strip partner teams; names are resolved to the active locale by `usePartnerTeams`. */
const PARTNER_TEAMS: readonly { nameKey: MessageKey; kindKey: MessageKey; icon: WebIconName }[] = [
  { nameKey: 'HomePage.partnerWebAgency', kindKey: 'HomePage.partnerKind', icon: 'grid' },
  { nameKey: 'HomePage.partnerDesignStudio', kindKey: 'HomePage.partnerKind', icon: 'pencil' },
  { nameKey: 'HomePage.partnerConsultancy', kindKey: 'HomePage.partnerKind', icon: 'briefcase' },
  { nameKey: 'HomePage.partnerInhouse', kindKey: 'HomePage.partnerKind', icon: 'person' },
  { nameKey: 'HomePage.partnerBrandStudio', kindKey: 'HomePage.partnerKind', icon: 'layers' },
  { nameKey: 'HomePage.partnerOpsTeam', kindKey: 'HomePage.partnerKind', icon: 'trend' },
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
  const partners: readonly LogoStripPartner[] = PARTNER_TEAMS.map((team) => ({
    name: t(team.nameKey),
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
