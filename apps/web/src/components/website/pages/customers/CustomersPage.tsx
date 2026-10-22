'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Avatar, Badge, StateCapsule } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import {
  ArrowLink,
  ButtonLink,
  CtaBand,
  Eyebrow,
  GraphCard,
  IconOrb,
  LogoStrip,
  ObjectCard,
  ObjectCardStack,
  SectionHeader,
  TestimonialCard,
  WebIcon,
  WebSection,
} from '../../index';
import {
  ACTION_OPEN,
  FEATURED_OUTCOMES,
  FILTERS,
  HERO_CARDS,
  PARTNERS,
  PORTAL,
  PROGRAMME_BENEFITS,
  QUOTES,
  SEGMENT_LABEL,
  STORIES,
  type Segment,
  type Story,
} from './customers-data';
import './customers.css';

/** Where "Join / Apply" lead until a dedicated programme form exists. */
const APPLY_HREF = '/contact?topic=design-partner';

/**
 * Customers & stories (SITE-SPEC "PAGE: Customers & stories", Figma 14-customers): hero, partner
 * strip, featured story, filterable story grid, quote wall, programme band and the CTA band.
 * Composed only from the shared website layer and packages/ui; `customers.css` lays it out with
 * Limeframe tokens.
 */
export function CustomersPage() {
  const t = useT();
  return (
    <div className="tm-web-customers">
      <Hero />
      <WebSection spacing="flush" className="tm-web-customers__partners">
        <LogoStrip
          variant="detailed"
          label={t('CustomersPage.partnersLabel')}
          partners={PARTNERS.map((partner) => ({
            name: t(partner.nameKey),
            kind: t(partner.kindKey),
            icon: partner.icon,
          }))}
        />
      </WebSection>
      <FeaturedStory />
      <Stories />
      <QuoteWall />
      <Programme />
      <CtaBand />
    </div>
  );
}

/* ── 2 · Hero ─────────────────────────────────────────────────────────────── */

function Hero() {
  const t = useT();
  return (
    <WebSection className="tm-web-customers__hero" aria-labelledby="customers-title">
      <div className="tm-web-customers__hero-grid">
        <SectionHeader
          as="h1"
          size="page"
          id="customers-title"
          eyebrow={t('CustomersPage.heroEyebrow')}
          title={t('CustomersPage.heroTitle')}
          lede={t('CustomersPage.heroLede')}
        >
          <div className="tm-web-customers__actions">
            <ButtonLink href={APPLY_HREF} tone="ink">
              {t('CustomersPage.heroJoinCta')}
            </ButtonLink>
            <Link href="#featured-story" className="tm-web-arrow-link tm-web-arrow-link--plain">
              <span className="tm-web-arrow-link__label">
                {t('CustomersPage.heroReadFeatured')}
              </span>
              <WebIcon name="arrow-down" size={14} />
            </Link>
          </div>
        </SectionHeader>
        <ObjectCardStack
          label={t('CustomersPage.heroStackLabel')}
          cards={HERO_CARDS.map((card) => ({
            title: t(card.titleKey),
            meta: t(card.metaKey),
            state: { tone: card.tone, label: t(card.stateKey) },
            owner: card.owner,
            secondary: t(ACTION_OPEN),
            primary: t(card.primaryKey),
          }))}
        />
      </div>
    </WebSection>
  );
}

/* ── 3 · Featured story (ink panel, visual right) ─────────────────────────── */

function PartnerPill({ line1, line2 }: { line1: string; line2?: string }) {
  return (
    <span className="tm-web-customers__pill">
      <IconOrb icon="building" tone="lime" size="compact" />
      <span className="tm-web-customers__pill-text">
        <span>{line1}</span>
        {line2 ? <span className="tm-web-customers__pill-sub">{line2}</span> : null}
      </span>
    </span>
  );
}

function FeaturedStory() {
  const t = useT();
  return (
    <WebSection
      spacing="compact"
      id="featured-story"
      className="tm-web-customers__featured-section"
      aria-labelledby="featured-story-title"
    >
      <div className="tm-web-customers__featured">
        <div className="tm-web-customers__featured-text">
          <PartnerPill
            line1={t('CustomersPage.partnerStudio')}
            line2={t('CustomersPage.partnerLogoConsent')}
          />
          <Eyebrow tone="ink">{t('CustomersPage.featuredEyebrow')}</Eyebrow>
          <h2 id="featured-story-title" className="tm-web-customers__featured-title">
            {t('CustomersPage.featuredTitle')}
          </h2>
          <ul className="tm-web-customers__outcomes">
            {FEATURED_OUTCOMES.map((line) => (
              <li key={line}>
                <IconOrb icon="check" tone="lime" />
                <span>{t(line)}</span>
              </li>
            ))}
          </ul>
          <ButtonLink href="#stories" tone="lime">
            {t('CustomersPage.featuredReadStory')}
            <WebIcon name="arrow-right" size={14} className="tm-web-icon--flip" />
          </ButtonLink>
          <p className="tm-web-customers__caption tm-web-customers__caption--ink">
            {t('CustomersPage.featuredCaption')}
          </p>
        </div>
        <PortalScene />
      </div>
    </WebSection>
  );
}

/** The client portal home as Atlas Hospitality sees it — a mini product scene, inert. */
function PortalScene() {
  const t = useT();
  return (
    <figure className="tm-web-scene tm-web-customers__portal">
      <figcaption className="tm-visually-hidden">{t('CustomersPage.portalSceneLabel')}</figcaption>
      <div className="tm-web-scene__body" aria-hidden="true" inert>
        <div className="tm-web-customers__portal-head">
          <Avatar name="Atlas Hospitality" audience="client" decorative />
          <span className="tm-web-customers__portal-org">
            <span className="tm-web-customers__portal-name">Atlas Hospitality</span>
            <span className="tm-web-customers__portal-sub">{t(PORTAL.sub)}</span>
          </span>
          <Badge tone="client">{t(PORTAL.badge)}</Badge>
        </div>
        <p className="tm-web-scene__mono tm-web-customers__portal-eyebrow">{t(PORTAL.eyebrow)}</p>
        <p className="tm-web-customers__portal-title">{t(PORTAL.title)}</p>
        <p className="tm-web-customers__portal-body">{t(PORTAL.body)}</p>
        <div className="tm-web-customers__portal-track">
          <StateCapsule state="done">{t(PORTAL.stepDone)}</StateCapsule>
          <StateCapsule state="current">{t(PORTAL.stepCurrent)}</StateCapsule>
          <StateCapsule state="future">{t(PORTAL.stepFuture)}</StateCapsule>
        </div>
        <p className="tm-web-customers__portal-actions">{t(PORTAL.actions)}</p>
        <ObjectCard
          title={t(PORTAL.cardTitle)}
          meta={t(PORTAL.cardMeta)}
          state={{ tone: 'client', label: t(PORTAL.cardState) }}
          owner="Maya Hassan"
          secondary={t(ACTION_OPEN)}
          primary={t(PORTAL.approve)}
        />
        <p className="tm-web-customers__portal-live">
          <span className="tm-web-eyebrow__dot" />
          <span>{t(PORTAL.live)}</span>
          <span className="tm-web-customers__portal-sub">{t(PORTAL.liveSub)}</span>
        </p>
      </div>
    </figure>
  );
}

/* ── 4–5 · Filter row and story grid ──────────────────────────────────────── */

function Stories() {
  const t = useT();
  const [filter, setFilter] = useState<Segment | 'all'>('all');
  const shown = filter === 'all' ? STORIES : STORIES.filter((story) => story.segment === filter);
  return (
    <WebSection id="stories" aria-labelledby="stories-title">
      <SectionHeader
        id="stories-title"
        eyebrow={t('CustomersPage.storiesEyebrow')}
        title={t('CustomersPage.storiesTitle')}
        lede={t('CustomersPage.storiesLede')}
      />
      <div className="tm-web-customers__filters">
        <div
          className="tm-web-customers__chips"
          role="group"
          aria-label={t('CustomersPage.filterAria')}
        >
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === filter ? 'tm-web-chip tm-web-chip--on' : 'tm-web-chip'}
              aria-pressed={option.id === filter}
              onClick={() => setFilter(option.id)}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
        <p className="tm-web-customers__count" aria-live="polite">
          {shown.length} {t('CustomersPage.countDraft')}{' '}
          {shown.length === 1
            ? t('CustomersPage.countStoryOne')
            : t('CustomersPage.countStoryMany')}{' '}
          {t('CustomersPage.countSuffix')}
        </p>
      </div>
      <ul className="tm-web-customers__grid">
        {shown.map((story) => (
          <li key={story.id}>
            <StoryCard story={story} />
          </li>
        ))}
      </ul>
    </WebSection>
  );
}

const STORY_TONE: Record<Segment, 'lime' | 'sunken' | 'ink'> = {
  agencies: 'lime',
  consultancies: 'sunken',
  'in-house': 'ink',
};

function StoryCard({ story }: { story: Story }) {
  const t = useT();
  const titleId = `story-${story.id}`;
  return (
    <article className="tm-web-customers__story" aria-labelledby={titleId}>
      <div
        className={`tm-web-customers__story-visual tm-web-customers__story-visual--${STORY_TONE[story.segment]}`}
        aria-hidden="true"
      >
        <div className="tm-web-customers__story-row">
          <PartnerPill line1={t('CustomersPage.partnerDesignPartner')} />
          <Badge>{t(SEGMENT_LABEL[story.segment])}</Badge>
        </div>
        <div className="tm-web-customers__story-row tm-web-customers__story-change">
          <StateCapsule state="waiting">{t(story.beforeKey)}</StateCapsule>
          <WebIcon name="arrow-right" size={16} className="tm-web-icon--flip" />
          <StateCapsule state="done">{t(story.afterKey)}</StateCapsule>
        </div>
      </div>
      <h3 id={titleId} className="tm-web-customers__story-title">
        {t(story.titleKey)}
      </h3>
      <p className="tm-web-customers__story-summary">{t(story.summaryKey)}</p>
      <div className="tm-web-customers__story-foot">
        <ArrowLink href={APPLY_HREF} underline={false}>
          {t('CustomersPage.storyRead')}
          <span className="tm-visually-hidden">: {t(story.titleKey)}</span>
        </ArrowLink>
        <span className="tm-web-customers__caption">{t('CustomersPage.storyComingSoon')}</span>
      </div>
    </article>
  );
}

/* ── 6 · Quote wall ───────────────────────────────────────────────────────── */

function QuoteWall() {
  const t = useT();
  return (
    <WebSection spacing="flush" className="tm-web-customers__quotes" aria-labelledby="quotes-title">
      <SectionHeader
        id="quotes-title"
        eyebrow={t('CustomersPage.quotesEyebrow')}
        title={t('CustomersPage.quotesTitle')}
        lede={t('CustomersPage.quotesLede')}
      />
      <div className="tm-web-customers__quote-grid">
        {QUOTES.map((quote) => (
          <TestimonialCard
            key={quote.id}
            quote={t(quote.quoteKey)}
            author={t(quote.authorKey)}
            org={t(quote.orgKey)}
            {...(quote.tone ? { tone: quote.tone } : {})}
          />
        ))}
      </div>
    </WebSection>
  );
}

/* ── 7 · Programme band (paper/150) ───────────────────────────────────────── */

function Programme() {
  const t = useT();
  return (
    <WebSection
      tone="sunken"
      aria-labelledby="programme-title"
      className="tm-web-customers__programme"
    >
      <div className="tm-web-customers__programme-grid">
        <SectionHeader
          id="programme-title"
          eyebrow={t('CustomersPage.programmeEyebrow')}
          title={t('CustomersPage.programmeTitle')}
          lede={t('CustomersPage.programmeLede')}
        >
          <div className="tm-web-customers__actions">
            <ButtonLink href={APPLY_HREF} tone="ink">
              {t('CustomersPage.programmeApply')}
            </ButtonLink>
            <ArrowLink href="/legal/privacy" underline={false}>
              {t('CustomersPage.programmePublish')}
            </ArrowLink>
          </div>
        </SectionHeader>
        <div className="tm-web-customers__benefits">
          {PROGRAMME_BENEFITS.map((benefit) => (
            <GraphCard
              key={benefit.titleKey}
              icon={benefit.icon}
              title={t(benefit.titleKey)}
              body={t(benefit.bodyKey)}
            />
          ))}
        </div>
      </div>
    </WebSection>
  );
}
