'use client';

import { Avatar } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import { Eyebrow, IconOrb } from '../../primitives';
import { CtaBand, LinkCard, SectionHeader, WebSection } from '../../sections';
import {
  HOW_WE_BUILD,
  PRINCIPLES,
  TEAM_PLACEHOLDER_COUNT,
  TEAM_PLACEHOLDER_NAME,
  WHY_PARAGRAPHS,
} from './about-data';
import './about.css';

/**
 * WEB-16 About (`/about`), built to the round-2 Figma frame (T-Manage Website, node 308:41):
 * editorial hero, "Why we exist" in three columns, numbered principle cards on the sunken band,
 * three ruled "How we build" columns, the team placeholder card, careers / press link cards, the
 * shared CTA band and the footer. Every value is a Limeframe token; every string is in the catalog.
 */
export function AboutPage() {
  return (
    <div className="tm-web-about">
      <Hero />
      <WhyWeExist />
      <Principles />
      <HowWeBuild />
      <Team />
      <CompanyCards />
      <CtaBand />
    </div>
  );
}

/* ── 2 · Hero (editorial, ruled underneath) ───────────────────────────────── */

function Hero() {
  const t = useT();
  return (
    <WebSection className="tm-web-about__hero" spacing="compact" aria-labelledby="about-title">
      <div className="tm-web-about__hero-inner">
        <SectionHeader
          as="h1"
          size="hero"
          id="about-title"
          eyebrow={t('AboutPage.heroEyebrow')}
          title={t('AboutPage.heroTitle')}
          lede={t('AboutPage.heroLede')}
        />
      </div>
    </WebSection>
  );
}

/* ── 3 · Why we exist: heading column + two text columns ──────────────────── */

function WhyWeExist() {
  const t = useT();
  return (
    <WebSection spacing="compact" aria-labelledby="about-why-title">
      <div className="tm-web-about__why">
        <div className="tm-web-about__why-head">
          <Eyebrow>{t('AboutPage.whyEyebrow')}</Eyebrow>
          <h2 id="about-why-title" className="tm-web-about__why-title">
            {t('AboutPage.whyHeading')}
          </h2>
        </div>
        {WHY_PARAGRAPHS.map((key) => (
          <p key={key} className="tm-web-about__why-para">
            {t(key)}
          </p>
        ))}
      </div>
    </WebSection>
  );
}

/* ── 4 · Principles: four numbered cards ──────────────────────────────────── */

function Principles() {
  const t = useT();
  return (
    <WebSection tone="sunken" aria-labelledby="about-principles-title">
      <SectionHeader
        id="about-principles-title"
        align="center"
        eyebrow={t('AboutPage.principlesEyebrow')}
        title={t('AboutPage.principlesHeading')}
      />
      <ol className="tm-web-about__principles">
        {PRINCIPLES.map((principle, index) => (
          <li key={principle.titleKey} className="tm-web-about__principle">
            <span className="tm-web-about__principle-top">
              <IconOrb icon={principle.icon} tone="lime" size="compact" />
              <span className="tm-web-about__principle-n" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
            </span>
            <h3 className="tm-web-about__principle-title">{t(principle.titleKey)}</h3>
          </li>
        ))}
      </ol>
    </WebSection>
  );
}

/* ── 5 · How we build: three ruled columns ────────────────────────────────── */

function HowWeBuild() {
  const t = useT();
  return (
    <WebSection spacing="compact" aria-labelledby="about-build-title">
      <SectionHeader
        id="about-build-title"
        eyebrow={t('AboutPage.buildEyebrow')}
        title={t('AboutPage.buildHeading')}
      />
      <ul className="tm-web-about__build">
        {HOW_WE_BUILD.map((item) => (
          <li key={item.titleKey} className="tm-web-about__build-item">
            <IconOrb icon={item.icon} tone="outline" size="compact" />
            <span className="tm-web-about__build-title">{t(item.titleKey)}</span>
          </li>
        ))}
      </ul>
    </WebSection>
  );
}

/* ── 6 · Team: placeholder avatars in one card ────────────────────────────── */

function Team() {
  const t = useT();
  return (
    <WebSection spacing="compact" aria-labelledby="about-team-title">
      <SectionHeader
        id="about-team-title"
        align="center"
        eyebrow={t('AboutPage.teamEyebrow')}
        title={t('AboutPage.teamTitle')}
      />
      <div className="tm-web-about__team">
        <ul className="tm-web-about__team-row" aria-label={t('AboutPage.teamPhotosSoon')}>
          {Array.from({ length: TEAM_PLACEHOLDER_COUNT }, (_, index) => (
            <li key={index} className="tm-web-about__team-member">
              <Avatar
                name={TEAM_PLACEHOLDER_NAME}
                size="feature"
                className="tm-web-about__team-avatar"
                decorative
              />
            </li>
          ))}
        </ul>
        <p className="tm-web-about__team-note">{t('AboutPage.teamPhotosSoon')}</p>
      </div>
    </WebSection>
  );
}

/* ── 7 · Work with us / Press & brand ─────────────────────────────────────── */

function CompanyCards() {
  const t = useT();
  return (
    <WebSection
      spacing="compact"
      className="tm-web-about__company"
      aria-label={t('AboutPage.companyAriaLabel')}
    >
      <div className="tm-web-about__cards">
        <div id="careers">
          <LinkCard
            title={t('AboutPage.careersTitle')}
            hint={t('AboutPage.careersHint')}
            href="/contact?topic=careers"
          />
        </div>
        <div id="press">
          <LinkCard
            title={t('AboutPage.pressTitle')}
            hint={t('AboutPage.pressHint')}
            href="/contact?topic=press"
          />
        </div>
      </div>
    </WebSection>
  );
}
