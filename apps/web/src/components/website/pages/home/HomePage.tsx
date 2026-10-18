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
import {
  AccessScene,
  ChatThreadScene,
  DecisionScene,
  HeroStoryScene,
  MyDayScene,
  PortalScene,
} from './HomeScenes';
import './home.css';

/**
 * WEB-01 Home (`/`). Every word comes from SITE-SPEC.md "PAGE: Home"; every part is a shared
 * website component or a packages/ui component; page-only styling lives in `home.css` and reads
 * Limeframe tokens only.
 */

/* ── 2. Hero ──────────────────────────────────────────────────────────────── */

function Hero() {
  return (
    <section className="tm-home-hero" aria-labelledby="home-hero-title">
      <div className="tm-web-container tm-home-hero__grid">
        <div className="tm-home-hero__copy">
          <Eyebrow>Work operating system for service teams</Eyebrow>
          <h1 id="home-hero-title" className="tm-home-hero__title">
            All the work. One connected story.
          </h1>
          <p className="tm-home-hero__lede">
            Plan, talk, deliver and get client approval in one place — without rebuilding context
            across five tools.
          </p>
          <div className="tm-home-hero__actions">
            <ButtonLink href="/sign-in" tone="lime">
              Start free
            </ButtonLink>
            <ButtonLink href="/contact" tone="outline">
              Book a demo
            </ButtonLink>
          </div>
          <p className="tm-home-hero__micro">
            Free for 2 people · Client users always free · No credit card
          </p>
        </div>
        <div className="tm-home-hero__visual">
          <HeroStoryScene />
        </div>
      </div>
    </section>
  );
}

/* ── 4. Work-story band ───────────────────────────────────────────────────── */

const STORY_STEPS = [
  'Request',
  'Clarify',
  'Commit',
  'Plan',
  'Review',
  'Publish',
  'Approve',
  'Deliver',
] as const;
const CURRENT_STEP = 4;

function WorkStory() {
  return (
    <WebSection aria-labelledby="home-story-title" id="work-story">
      <SectionHeader
        id="home-story-title"
        align="center"
        eyebrow="How work moves"
        title="From the first ask to the signed-off file, nothing is retyped."
        lede="Every step is the same object, so the context travels with it."
      />
      <div className="tm-home-track">
        <ol className="tm-home-track__list" aria-label="The eight steps of one work story">
          {STORY_STEPS.map((step, i) => {
            const state = i < CURRENT_STEP ? 'done' : i === CURRENT_STEP ? 'current' : 'future';
            return (
              <li
                key={step}
                className={cx('tm-home-track__step', `tm-home-track__step--${state}`)}
                aria-current={i === CURRENT_STEP ? 'step' : undefined}
              >
                <span className="tm-home-track__n">{String(i + 1).padStart(2, '0')}</span>
                <StateCapsule state={state}>{step}</StateCapsule>
              </li>
            );
          })}
        </ol>
        <p className="tm-home-track__caption">
          A desired date stays a wish until someone commits to it.
        </p>
      </div>
    </WebSection>
  );
}

/* ── 5. Pillar tabs ───────────────────────────────────────────────────────── */

interface PillarRow {
  title: string;
  body: string;
  link: { label: string; href: string };
  visual: ReactNode;
}

const PILLARS: readonly { id: string; label: string; rows: readonly PillarRow[] }[] = [
  {
    id: 'team',
    label: 'Team',
    rows: [
      {
        title: 'Turn a message into work in one move.',
        body: 'Convert any chat message into a task, request or decision. The source thread stays linked, and the audience never widens by accident.',
        link: { label: 'Explore chat', href: '/features/communication' },
        visual: <ChatThreadScene />,
      },
      {
        title: 'Know what matters next.',
        body: 'My Day ranks your work by consequence and explains why each item is there.',
        link: { label: 'See Home', href: '/product#focus-space' },
        visual: <MyDayScene />,
      },
    ],
  },
  {
    id: 'clients',
    label: 'Clients',
    rows: [
      {
        title: 'A portal your client can use without training.',
        body: 'Progress, their actions and the exact versions to review — generated from an allowlist, so internal work stays invisible.',
        link: { label: 'Explore the client portal', href: '/client-portal' },
        visual: <PortalScene />,
      },
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    rows: [
      {
        title: 'Decisions you can find six months later.',
        body: 'Docs, briefs and the decision register live beside the work they explain, with links that stay current.',
        link: { label: 'Explore docs', href: '/features/knowledge' },
        visual: <DecisionScene />,
      },
    ],
  },
  {
    id: 'control',
    label: 'Control',
    rows: [
      {
        title: 'Access you can explain to an auditor.',
        body: 'Roles, client access expiry, offboarding and an append-only audit log — with an impact preview before every change.',
        link: { label: 'See security', href: '/security' },
        visual: <AccessScene />,
      },
    ],
  },
];

function PillarTabs() {
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
        What TManage does for each part of the work
      </h2>
      <div className="tm-home-tabs">
        <div
          className="tm-segmented tm-home-tabs__list"
          role="tablist"
          aria-label="Product pillars"
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
              {pillar.label}
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
              key={row.title}
              title={row.title}
              body={row.body}
              link={row.link}
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

const HOME_STATS: readonly StatProps[] = [
  {
    value: '1',
    unit: 'version',
    label: 'governed version per approval',
    note: 'Change the file and the approval is invalidated, not overwritten.',
  },
  {
    value: '3',
    unit: 'dates',
    label: 'separate dates: desired, committed, forecast',
    note: 'So a wish is never mistaken for a promise.',
  },
  {
    value: '0',
    unit: 'comments',
    label: 'internal comments shared by default',
    note: 'Client visibility is always an explicit choice.',
  },
  {
    value: '2',
    unit: 'languages',
    label: 'languages, fully mirrored',
    note: 'English and Arabic, left-to-right and right-to-left.',
  },
];

function Stats() {
  return (
    <WebSection
      tone="sunken"
      spacing="compact"
      aria-labelledby="home-stats-title"
      className="tm-home-stats"
    >
      <h2 id="home-stats-title" className="tm-visually-hidden">
        Product facts
      </h2>
      <StatBand stats={HOME_STATS} />
      <p className="tm-home-stats__foot">
        <span className="tm-web-eyebrow__dot" aria-hidden="true" />
        <span className="tm-web-scene__mono">Product facts, not usage claims.</span>
      </p>
    </WebSection>
  );
}

/* ── 7. Who it's for ──────────────────────────────────────────────────────── */

const AUDIENCES: readonly { title: string; body: string; href: string; icon: WebIconName }[] = [
  {
    title: 'Agencies & studios',
    body: 'Run many clients without losing the thread.',
    href: '/solutions/agencies',
    icon: 'grid',
  },
  {
    title: 'Consultancies',
    body: 'Make every recommendation traceable to a decision.',
    href: '/solutions/consultancies',
    icon: 'briefcase',
  },
  {
    title: 'In-house teams',
    body: 'Treat internal stakeholders like clients, with the same clarity.',
    href: '/solutions/in-house',
    icon: 'building',
  },
];

function WhoItsFor() {
  return (
    <WebSection aria-labelledby="home-who-title" className="tm-home-who">
      <SectionHeader
        id="home-who-title"
        eyebrow="Who it's for"
        title="Built for teams who deliver work to someone else."
      />
      <ul className="tm-home-cards tm-home-cards--3">
        {AUDIENCES.map((a) => (
          <li key={a.href}>
            <Link href={a.href} className="tm-home-card">
              <IconOrb icon={a.icon} tone="lime" />
              <span className="tm-home-card__title">{a.title}</span>
              <span className="tm-home-card__body">{a.body}</span>
              <span className="tm-home-card__foot">
                <span className="tm-home-card__more">See the solution</span>
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

const PORTAL_POINTS = [
  'Progress from milestone evidence, not task counts',
  'Approvals bound to the exact version reviewed',
  'Client users are free on every plan',
] as const;

function PortalSpotlight() {
  return (
    <WebSection
      spacing="flush"
      aria-labelledby="home-portal-title"
      className="tm-home-spot-section"
    >
      <div className="tm-home-spot">
        <div className="tm-home-spot__text">
          <Eyebrow tone="ink">Outside, with the client</Eyebrow>
          <h2 id="home-portal-title" className="tm-home-spot__title">
            Your client knows where things stand in thirty seconds.
          </h2>
          <ul className="tm-home-spot__points">
            {PORTAL_POINTS.map((point) => (
              <li key={point}>
                <IconOrb icon="check" tone="lime" size="compact" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <ButtonLink href="/client-portal" tone="lime">
            See a live demo portal
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
  quote: string;
  author: string;
  team: string;
  org: string;
  icon: WebIconName;
}[] = [
  {
    quote: 'We stopped running status calls. The client opens the portal instead.',
    author: 'Studio lead',
    team: 'Agency',
    org: 'Brand & web agency · Design partner',
    icon: 'grid',
  },
  {
    quote: 'Approvals finally point at one file.',
    author: 'Delivery director',
    team: 'Consultancy',
    org: 'Management consultancy · Design partner',
    icon: 'briefcase',
  },
  {
    quote: 'Our Arabic-speaking clients use it in Arabic, properly.',
    author: 'Operations manager',
    team: 'In-house team',
    org: 'Hospitality group · Design partner',
    icon: 'building',
  },
];

function Stories() {
  return (
    <WebSection aria-labelledby="home-stories-title" className="tm-home-stories">
      <SectionHeader
        id="home-stories-title"
        eyebrow="Design partners"
        title="Built alongside the teams who will use it."
      />
      <ul className="tm-home-cards tm-home-cards--3 tm-home-stories__list">
        {STORIES.map((s, i) => (
          <li key={s.quote}>
            <figure
              className={cx('tm-web-quote', 'tm-home-story-card', i === 1 && 'tm-web-quote--ink')}
            >
              <span className="tm-home-story-card__logo">
                <IconOrb icon={s.icon} tone="lime" size="compact" />
                <span className="tm-home-story-card__team">{s.team}</span>
              </span>
              <blockquote className="tm-web-quote__text">
                <p>“{s.quote}”</p>
              </blockquote>
              <figcaption className="tm-web-quote__by">
                <Avatar name={s.author} audience="client" decorative />
                <span className="tm-web-quote__who">
                  <span className="tm-web-quote__role">{s.author}</span>
                  <span className="tm-web-quote__org">{s.org}</span>
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
  kind: string;
  title: string;
  meta: string;
  icon: WebIconName;
  href: string;
}[] = [
  {
    kind: 'Guide',
    title: 'The client approval playbook',
    meta: '12 min read',
    icon: 'book',
    href: '/resources#res-feat-title',
  },
  {
    kind: 'Template',
    title: 'Website relaunch project template',
    meta: '8 milestones · 46 work items',
    icon: 'layers',
    href: '/features/work#templates',
  },
  {
    kind: 'Blog',
    title: 'Why desired, committed and forecast dates are different',
    meta: '6 min read',
    icon: 'pencil',
    href: '/resources#res-library',
  },
  {
    kind: 'Walkthrough',
    title: 'One request, start to finish (4 min)',
    meta: 'Video · 4 min',
    icon: 'video',
    href: '/features/work#requests',
  },
];

function Resources() {
  return (
    <WebSection aria-labelledby="home-resources-title" className="tm-home-resources">
      <SectionHeader
        id="home-resources-title"
        eyebrow="Resources"
        title="Learn the way connected teams work."
        link={{ label: 'All resources', href: '/resources' }}
      />
      <ul className="tm-home-cards tm-home-cards--4">
        {RESOURCES.map((r) => (
          <li key={r.title}>
            <Link href={r.href} className="tm-home-card tm-home-card--resource">
              <span className="tm-home-card__top">
                <Badge mono>{r.kind.toUpperCase()}</Badge>
                <IconOrb icon={r.icon} tone="tint" size="compact" />
              </span>
              <span className="tm-home-card__title">{r.title}</span>
              <span className="tm-home-card__foot">
                <span className="tm-home-card__more">{r.meta}</span>
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

const PARTNER_TEAMS: readonly LogoStripPartner[] = [
  { name: 'Web agency', kind: 'Design partner', icon: 'grid' },
  { name: 'Design studio', kind: 'Design partner', icon: 'pencil' },
  { name: 'Consultancy', kind: 'Design partner', icon: 'briefcase' },
  { name: 'In-house team', kind: 'Design partner', icon: 'person' },
  { name: 'Brand studio', kind: 'Design partner', icon: 'layers' },
  { name: 'Ops team', kind: 'Design partner', icon: 'trend' },
];

/* ── 11. CTA band ─────────────────────────────────────────────────────────────
 * Web/CTA band markup with the spec's "Outline on ink" demo button (the same plain outline
 * button the hero uses) and the Delivery risk view shown whole (see home.css). */

function HomeCta() {
  return (
    <section className="tm-web-cta-section tm-home-cta" aria-labelledby="home-cta-title">
      <div className="tm-web-container">
        <div className="tm-web-cta">
          <div className="tm-web-cta__text">
            <h2 id="home-cta-title" className="tm-web-cta__title">
              Bring the next client project into one story.
            </h2>
            <p className="tm-web-cta__lede">
              Start free with your team. Invite your client when the first deliverable is ready.
            </p>
            <div className="tm-web-cta__actions">
              <ButtonLink href="/sign-in" tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline-ink">
                Book a demo
              </ButtonLink>
            </div>
            <p className="tm-web-cta__note">No credit card · Client users are always free</p>
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
  return (
    <div className="tm-home">
      <Hero />
      <WebSection spacing="flush" className="tm-home-logos">
        <LogoStrip variant="detailed" partners={PARTNER_TEAMS} />
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
