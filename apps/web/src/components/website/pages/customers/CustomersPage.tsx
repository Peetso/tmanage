'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Avatar, Badge, StateCapsule } from '@tmanage/ui';
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
  FEATURED_OUTCOMES,
  FILTERS,
  PARTNERS,
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
  return (
    <div className="tm-web-customers">
      <Hero />
      <WebSection spacing="flush" className="tm-web-customers__partners">
        <LogoStrip
          variant="detailed"
          label="Design partners · logos appear only with written consent"
          partners={PARTNERS}
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
  return (
    <WebSection className="tm-web-customers__hero" aria-labelledby="customers-title">
      <div className="tm-web-customers__hero-grid">
        <SectionHeader
          as="h1"
          size="page"
          id="customers-title"
          eyebrow="Customers"
          title="Built with the teams who deliver for clients every day."
          lede="Stories from our design-partner programme — what changed when the work became one story."
        >
          <div className="tm-web-customers__actions">
            <ButtonLink href={APPLY_HREF} tone="ink">
              Join the design-partner programme
            </ButtonLink>
            <Link href="#featured-story" className="tm-web-arrow-link tm-web-arrow-link--plain">
              <span className="tm-web-arrow-link__label">Read the featured story</span>
              <WebIcon name="arrow-down" size={14} />
            </Link>
          </div>
        </SectionHeader>
        <ObjectCardStack
          label="Two client deliverables: Homepage Concept v2, approved, and the Arabic FAQ page, in progress."
          cards={[
            {
              title: 'Homepage Concept v2',
              meta: 'Atlas Hospitality · approved by Youssef · 18 Aug',
              state: { tone: 'done', label: 'Approved' },
              owner: 'Maya Hassan',
              secondary: 'Open',
              primary: 'Download v2',
            },
            {
              title: 'Arabic FAQ page',
              meta: 'Asked in chat · committed for 24 Aug',
              state: { tone: 'current', label: 'In progress' },
              owner: 'Omar Adel',
              secondary: 'Open',
              primary: 'Review',
            },
          ]}
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
  return (
    <WebSection
      spacing="compact"
      id="featured-story"
      className="tm-web-customers__featured-section"
      aria-labelledby="featured-story-title"
    >
      <div className="tm-web-customers__featured">
        <div className="tm-web-customers__featured-text">
          <PartnerPill line1="Design partner · studio" line2="Logo shown with consent" />
          <Eyebrow tone="ink">Featured story · Agencies &amp; studios</Eyebrow>
          <h2 id="featured-story-title" className="tm-web-customers__featured-title">
            How a 12-person studio replaced its Friday status calls
          </h2>
          <ul className="tm-web-customers__outcomes">
            {FEATURED_OUTCOMES.map((line) => (
              <li key={line}>
                <IconOrb icon="check" tone="lime" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <ButtonLink href="#stories" tone="lime">
            Read the story
            <WebIcon name="arrow-right" size={14} className="tm-web-icon--flip" />
          </ButtonLink>
          <p className="tm-web-customers__caption tm-web-customers__caption--ink">
            Customer story · coming soon
          </p>
        </div>
        <PortalScene />
      </div>
    </WebSection>
  );
}

/** The client portal home as Atlas Hospitality sees it — a mini product scene, inert. */
function PortalScene() {
  return (
    <figure className="tm-web-scene tm-web-customers__portal">
      <figcaption className="tm-visually-hidden">
        Atlas Hospitality’s client portal: the website relaunch is on track, and one approval — the
        homepage direction — is waiting on the client.
      </figcaption>
      <div className="tm-web-scene__body" aria-hidden="true" inert>
        <div className="tm-web-customers__portal-head">
          <Avatar name="Atlas Hospitality" audience="client" decorative />
          <span className="tm-web-customers__portal-org">
            <span className="tm-web-customers__portal-name">Atlas Hospitality</span>
            <span className="tm-web-customers__portal-sub">Delivered by Northstar Studio</span>
          </span>
          <Badge tone="client">Client portal</Badge>
        </div>
        <p className="tm-web-scene__mono tm-web-customers__portal-eyebrow">
          Your project · On track
        </p>
        <p className="tm-web-customers__portal-title">Website relaunch</p>
        <p className="tm-web-customers__portal-body">
          Everything is moving toward the 30 Sep launch. One decision from you keeps it there.
        </p>
        <div className="tm-web-customers__portal-track">
          <StateCapsule state="done">Discovery</StateCapsule>
          <StateCapsule state="current">Homepage direction</StateCapsule>
          <StateCapsule state="future">Launch</StateCapsule>
        </div>
        <p className="tm-web-customers__portal-actions">Your actions</p>
        <ObjectCard
          title="Approve the homepage direction"
          meta="Homepage Concept v2 · waiting for you since Tue"
          state={{ tone: 'client', label: 'Your turn' }}
          owner="Maya Hassan"
          secondary="Open"
          primary="Approve"
        />
        <p className="tm-web-customers__portal-live">
          <span className="tm-web-eyebrow__dot" />
          <span>Live now</span>
          <span className="tm-web-customers__portal-sub">
            Omar shared Homepage Concept v2 this morning
          </span>
        </p>
      </div>
    </figure>
  );
}

/* ── 4–5 · Filter row and story grid ──────────────────────────────────────── */

function Stories() {
  const [filter, setFilter] = useState<Segment | 'all'>('all');
  const shown = filter === 'all' ? STORIES : STORIES.filter((story) => story.segment === filter);
  return (
    <WebSection id="stories" aria-labelledby="stories-title">
      <SectionHeader
        id="stories-title"
        eyebrow="Stories"
        title="What changed, team by team."
        lede="Draft stories from our design-partner programme. Each one is published only with the partner’s consent."
      />
      <div className="tm-web-customers__filters">
        <div className="tm-web-customers__chips" role="group" aria-label="Filter stories by team">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === filter ? 'tm-web-chip tm-web-chip--on' : 'tm-web-chip'}
              aria-pressed={option.id === filter}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="tm-web-customers__count" aria-live="polite">
          {shown.length} draft {shown.length === 1 ? 'story' : 'stories'} · each published only with
          partner consent
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
  const titleId = `story-${story.id}`;
  return (
    <article className="tm-web-customers__story" aria-labelledby={titleId}>
      <div
        className={`tm-web-customers__story-visual tm-web-customers__story-visual--${STORY_TONE[story.segment]}`}
        aria-hidden="true"
      >
        <div className="tm-web-customers__story-row">
          <PartnerPill line1="Design partner" />
          <Badge>{SEGMENT_LABEL[story.segment]}</Badge>
        </div>
        <div className="tm-web-customers__story-row tm-web-customers__story-change">
          <StateCapsule state="waiting">{story.before}</StateCapsule>
          <WebIcon name="arrow-right" size={16} className="tm-web-icon--flip" />
          <StateCapsule state="done">{story.after}</StateCapsule>
        </div>
      </div>
      <h3 id={titleId} className="tm-web-customers__story-title">
        {story.title}
      </h3>
      <p className="tm-web-customers__story-summary">{story.summary}</p>
      <div className="tm-web-customers__story-foot">
        <ArrowLink href={APPLY_HREF} underline={false}>
          Read
          <span className="tm-visually-hidden">: {story.title}</span>
        </ArrowLink>
        <span className="tm-web-customers__caption">Coming soon</span>
      </div>
    </article>
  );
}

/* ── 6 · Quote wall ───────────────────────────────────────────────────────── */

function QuoteWall() {
  return (
    <WebSection spacing="flush" className="tm-web-customers__quotes" aria-labelledby="quotes-title">
      <SectionHeader
        id="quotes-title"
        eyebrow="In their words"
        title="What partners tell us after a few weeks."
        lede="Draft wording from design-partner sessions. Shown here only once each partner approves it."
      />
      <div className="tm-web-customers__quote-grid">
        {QUOTES.map(({ id, ...quote }) => (
          <TestimonialCard key={id} {...quote} />
        ))}
      </div>
    </WebSection>
  );
}

/* ── 7 · Programme band (paper/150) ───────────────────────────────────────── */

function Programme() {
  return (
    <WebSection
      tone="sunken"
      aria-labelledby="programme-title"
      className="tm-web-customers__programme"
    >
      <div className="tm-web-customers__programme-grid">
        <SectionHeader
          id="programme-title"
          eyebrow="Design-partner programme"
          title="Become a design partner."
          lede="Shape the product, get early access and direct support. We publish your story only if you want us to."
        >
          <div className="tm-web-customers__actions">
            <ButtonLink href={APPLY_HREF} tone="ink">
              Apply
            </ButtonLink>
            <ArrowLink href="/legal/privacy" underline={false}>
              How we publish stories
            </ArrowLink>
          </div>
        </SectionHeader>
        <div className="tm-web-customers__benefits">
          {PROGRAMME_BENEFITS.map((benefit) => (
            <GraphCard key={benefit.title} {...benefit} />
          ))}
        </div>
      </div>
    </WebSection>
  );
}
