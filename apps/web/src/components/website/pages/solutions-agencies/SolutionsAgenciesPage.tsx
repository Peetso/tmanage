'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, StateCapsule, type CapsuleState } from '@tmanage/ui';
import {
  ArrowLink,
  ButtonLink,
  Eyebrow,
  IconOrb,
  ProductVisualFrame,
  SectionHeader,
  WebIcon,
  WebSection,
  type WebIconName,
} from '../../index';
import { cx } from '../../primitives';
import {
  ClientBoundariesScene,
  CreativeReviewScene,
  PortfolioScene,
  RetainerPlanScene,
} from './scenes';
import './solutions-agencies.css';

/**
 * Solutions · Agencies & studios (WEB-08, SITE-SPEC "PAGE: Solutions · Agencies & studios").
 * No Figma frame exists for this page; it follows the designed sibling Solutions · Consultancies
 * section for section: hero + product visual, pain → answer cards on paper/150, a five-step
 * workflow strip, three alternating rows, template cards, a design-partner story, the CTA band.
 */

const STORY_FACTS: readonly { icon: WebIconName; label: string; hint: string }[] = [
  {
    icon: 'calendar',
    label: 'Hours spent preparing each client status update',
    hint: 'Measured with the design partner, before and after the portal.',
  },
  {
    icon: 'layers',
    label: 'Review rounds per deliverable',
    hint: 'Counted from the decision trail, not from a survey.',
  },
];

const PAINS: readonly { pain: string; answer: string; body: string }[] = [
  {
    pain: 'Feedback scattered across email and calls',
    answer: 'One request queue per client',
    body: 'Every ask lands in that client’s queue with an owner and a status, whoever it came from and however it arrived.',
  },
  {
    pain: '‘Which version did they approve?’',
    answer: 'Approval bound to one version',
    body: 'An approval names the exact file it was given on. Change the file and the approval is invalidated, not carried over.',
  },
  {
    pain: 'Weekly status decks',
    answer: 'A portal and a drafted pulse',
    body: 'Clients open their own portal. The weekly pulse is drafted from the work itself, and you edit it before it goes out.',
  },
];

const STEPS: readonly { title: string; body: string; state: CapsuleState; label: string }[] = [
  {
    title: 'Brief',
    body: 'The client’s request becomes a brief with an owner and a desired date.',
    state: 'done',
    label: 'Done',
  },
  {
    title: 'Concept',
    body: 'Concepts are versioned deliverables, linked to the brief that asked for them.',
    state: 'done',
    label: 'Done',
  },
  {
    title: 'Internal review',
    body: 'Your team checks the work against the criteria before a client sees it.',
    state: 'current',
    label: 'In progress',
  },
  {
    title: 'Client review',
    body: 'The client approves one version, or asks for changes with a reason.',
    state: 'client',
    label: 'Client review',
  },
  {
    title: 'Final delivery',
    body: 'Approved files are handed over with the decision trail attached.',
    state: 'future',
    label: 'Next',
  },
];

const TEMPLATES: readonly {
  title: string;
  body: string;
  icon: WebIconName;
  facts: readonly string[];
}[] = [
  {
    title: 'Website relaunch',
    body: 'Discovery, sitemap, design concepts, build and launch, with client reviews at each gate.',
    icon: 'globe',
    facts: ['6 milestones', '3 client approvals'],
  },
  {
    title: 'Brand identity sprint',
    body: 'Research, territories, one chosen direction and a guidelines handover in a fixed number of weeks.',
    icon: 'pencil',
    facts: ['4 milestones', '2 client approvals'],
  },
  {
    title: 'Campaign production',
    body: 'Key visual, adaptations per channel and a delivery checklist the client can follow.',
    icon: 'layers',
    facts: ['5 milestones', '1 approval per asset'],
  },
];

function Checklist({ items }: { items: readonly string[] }) {
  return (
    <ul className="tm-web-ag-checklist">
      {items.map((item) => (
        <li key={item}>
          <WebIcon name="check" size={14} />
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * The shared FeatureRow layout (tm-web-feature classes), with the page's mono + lime-dot Eyebrow
 * as the row label so every eyebrow on the page reads the same.
 */
function AgRow({
  label,
  title,
  body,
  link,
  visual,
  reverse = false,
  children,
}: {
  label: string;
  title: string;
  body: string;
  link: { label: string; href: string };
  visual: ReactNode;
  reverse?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={cx('tm-web-feature', reverse && 'tm-web-feature--reverse')}>
      <div className="tm-web-feature__text">
        <Eyebrow>{label}</Eyebrow>
        <h3 className="tm-web-feature__title">{title}</h3>
        <p className="tm-web-feature__body">{body}</p>
        {children}
        <ArrowLink href={link.href} underline={false}>
          {link.label}
        </ArrowLink>
      </div>
      <ProductVisualFrame>{visual}</ProductVisualFrame>
    </div>
  );
}

export function SolutionsAgenciesPage() {
  return (
    <>
      {/* 2 · Hero */}
      <WebSection spacing="compact" className="tm-web-ag-hero" aria-labelledby="ag-hero-title">
        <div className="tm-web-ag-hero__grid">
          <div className="tm-web-ag-hero__text">
            <Badge mono className="tm-web-ag-hero__eyebrow">
              For agencies &amp; studios
            </Badge>
            <SectionHeader
              title="Run every client project in one place — and give each client their own."
              lede="Briefs, production, reviews and sign-off for many clients at once, without a portal per tool."
              as="h1"
              size="page"
              id="ag-hero-title"
            />
            <div className="tm-web-ag-hero__actions">
              <ButtonLink href="/sign-in" tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                Book a demo
              </ButtonLink>
            </div>
            <p className="tm-web-ag-hero__note">No credit card · Client users are always free</p>
          </div>
          <ProductVisualFrame className="tm-web-ag-hero__visual">
            <PortfolioScene />
          </ProductVisualFrame>
        </div>
      </WebSection>

      {/* 3 · Pain → answer */}
      <WebSection tone="sunken" aria-labelledby="ag-pain-title">
        <SectionHeader
          align="center"
          eyebrow="Why studios switch"
          title="Good work deserves a cleaner hand-off."
          lede="The three problems we hear most from agency leads, and how TManage answers each one."
          id="ag-pain-title"
        />
        <ul className="tm-web-ag-pains">
          {PAINS.map((item) => (
            <li key={item.answer} className="tm-web-ag-pain">
              <Badge>Today</Badge>
              <p className="tm-web-ag-pain__problem">{item.pain}</p>
              <div className="tm-web-ag-pain__answer">
                <p className="tm-web-ag-pain__with">
                  <WebIcon name="check" size={14} />
                  With TManage
                </p>
                <h3 className="tm-web-ag-pain__title">{item.answer}</h3>
                <p className="tm-web-ag-pain__body">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 4 · Workflow strip */}
      <WebSection aria-labelledby="ag-flow-title">
        <SectionHeader
          align="center"
          eyebrow="How a deliverable flows"
          title="From brief to final delivery, in one line."
          lede="Each stage hands the next one its evidence, so nobody re-explains the project to the client."
          id="ag-flow-title"
        />
        <ol className="tm-web-ag-flow">
          {STEPS.map((step, index) => (
            <li key={step.title} className="tm-web-ag-step">
              <span className="tm-web-scene__mono">{String(index + 1).padStart(2, '0')}</span>
              <StateCapsule state={step.state}>{step.label}</StateCapsule>
              <h3 className="tm-web-ag-step__title">{step.title}</h3>
              <p className="tm-web-ag-step__body">{step.body}</p>
              {index < STEPS.length - 1 ? (
                <span className="tm-web-ag-step__arrow" aria-hidden="true">
                  <WebIcon name="arrow-right" size={14} className="tm-web-icon--flip" />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </WebSection>

      {/* 5 · Alternating rows */}
      <WebSection aria-label="What changes for your studio" className="tm-web-ag-rows">
        <AgRow
          label="Client boundaries"
          title="Many clients, clean boundaries."
          body="Each client organization sees only its own projects. One workspace for your studio, one calm view per client."
          link={{ label: 'See the client portal', href: '/client-portal' }}
          visual={<ClientBoundariesScene />}
        >
          <Checklist
            items={[
              'A portal per client organization, not per tool',
              'Internal comments and costs never reach the portal',
              'Client users are free on every plan',
            ]}
          />
        </AgRow>
        <AgRow
          reverse
          label="Creative review"
          title="Creative review that holds up."
          body="Criteria, versions and a decision trail for every deliverable — so the answer to ‘who approved this?’ is one click away."
          link={{ label: 'Explore docs & decisions', href: '/features/knowledge' }}
          visual={<CreativeReviewScene />}
        >
          <Checklist
            items={[
              'Review criteria agreed before the first concept',
              'Each approval bound to one exact version',
              'Requested changes carry a reason',
            ]}
          />
        </AgRow>
        <AgRow
          label="Retainers"
          title="Retainers without the chaos."
          body="Recurring requests flow into a monthly plan. The client sees what is committed, what is only desired, and what is next."
          link={{ label: 'Explore work & requests', href: '/features/work' }}
          visual={<RetainerPlanScene />}
        >
          <Checklist
            items={[
              'Recurring requests created on schedule',
              'Committed and desired dates kept apart',
              'The month’s plan visible to the client',
            ]}
          />
        </AgRow>
      </WebSection>

      {/* 6 · Template cards */}
      <WebSection tone="sunken" aria-labelledby="ag-templates-title">
        <SectionHeader
          eyebrow="Templates for client delivery"
          title="Start from the projects you already run."
          lede="Milestones, review gates and client approvals set up the way studios work. Change anything after you start."
          id="ag-templates-title"
        />
        <ul className="tm-web-ag-templates">
          {TEMPLATES.map((template) => (
            <li key={template.title} className="tm-web-ag-template">
              <IconOrb icon={template.icon} tone="lime" />
              <h3 className="tm-web-ag-template__title">{template.title}</h3>
              <p className="tm-web-ag-template__body">{template.body}</p>
              <p className="tm-web-ag-template__facts">
                {template.facts.map((fact) => (
                  <span key={fact} className="tm-web-chip">
                    {fact}
                  </span>
                ))}
              </p>
              <ArrowLink href="/sign-in" underline={false}>
                Use this template
              </ArrowLink>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 7 · Story card (design-partner story, one white panel as on Consultancies) */}
      <WebSection aria-label="Customer story" className="tm-web-ag-story-section">
        <figure className="tm-web-ag-story">
          <div className="tm-web-ag-story__quote">
            <Badge>Customer story · coming soon</Badge>
            <blockquote className="tm-web-ag-story__text">
              <p>
                “A design-partner studio will tell how one portal per client replaced their weekly
                status decks.”
              </p>
            </blockquote>
            <figcaption className="tm-web-ag-story__by">
              <Avatar name="Studio lead" audience="client" decorative />
              <span>
                <span className="tm-web-ag-story__name">Studio lead</span>
                <span className="tm-web-ag-story__org">Design-partner agency</span>
              </span>
            </figcaption>
          </div>
          <ul className="tm-web-ag-story__facts" aria-label="What the story will measure">
            {STORY_FACTS.map((fact) => (
              <li key={fact.label} className="tm-web-ag-fact">
                <IconOrb icon={fact.icon} tone="lime" />
                <span className="tm-web-ag-fact__text">
                  <span className="tm-web-ag-fact__label">{fact.label}</span>
                  <span className="tm-web-ag-fact__hint">{fact.hint}</span>
                </span>
              </li>
            ))}
          </ul>
        </figure>
      </WebSection>

      {/* 8 · CTA band (text-only, as on Consultancies) */}
      <section className="tm-web-cta-section tm-web-ag-cta" aria-labelledby="ag-cta-title">
        <div className="tm-web-container">
          <div className="tm-web-cta tm-web-cta--text">
            <div className="tm-web-cta__text">
              <h2 id="ag-cta-title" className="tm-web-cta__title">
                Bring the next client project into one story.
              </h2>
              <p className="tm-web-cta__lede tm-web-ag-cta__lede">
                Start free with your team. Invite your client when the first deliverable is ready.
              </p>
              <div className="tm-web-cta__actions tm-web-ag-cta__actions">
                <ButtonLink href="/sign-in" tone="lime">
                  Start free
                </ButtonLink>
                <ButtonLink href="/contact" tone="outline-ink">
                  Book a demo
                </ButtonLink>
              </div>
              <p className="tm-web-cta__note tm-web-ag-cta__note">
                No credit card · Client users are always free
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
