'use client';

import { Avatar, Badge, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { WebIcon } from '../../WebIcon';
import { ButtonLink, Eyebrow, IconOrb } from '../../primitives';
import { CtaBand, FeatureRow, SectionHeader, WebSection } from '../../sections';
import {
  DecisionDetailScene,
  DecisionRegisterScene,
  EngagementStoryScene,
  SteeringHealthScene,
} from './scenes';
import './consultancies.css';

/**
 * Solutions · Consultancies (SITE-SPEC "PAGE: Solutions · Consultancies", Figma shot
 * 09-solutions-consultancies). Composed from the shared website layer; the only page-specific
 * parts are the pain → answer card, the workflow step card, the ink security callout, the story
 * card and the four product scenes, all drawn with Limeframe tokens in `consultancies.css`.
 */

const PAINS = [
  {
    pain: 'Decisions lost in slide decks',
    answer: 'A decision register with owners',
    body: 'Every decision has an owner, a date and the evidence behind it, searchable long after the deck is gone.',
  },
  {
    pain: 'Scope creep by email',
    answer: 'Requests that need a commitment',
    body: 'New asks arrive as requests. Nothing becomes work until someone commits to scope, date and owner.',
  },
  {
    pain: 'Sensitive client data',
    answer: 'Tenant isolation and audit by default',
    body: 'Each client organisation sees only its own engagements, and every view, export and approval is logged.',
  },
] as const;

const STEPS: readonly { title: string; body: string; state: CapsuleState; label: string }[] = [
  {
    title: 'Discovery',
    body: 'Interviews, data requests and notes land in one engagement.',
    state: 'done',
    label: 'Done',
  },
  {
    title: 'Findings',
    body: 'Each finding links to the evidence that supports it.',
    state: 'done',
    label: 'Done',
  },
  {
    title: 'Recommendation',
    body: 'Options, trade-offs and one clear proposed path.',
    state: 'current',
    label: 'In progress',
  },
  {
    title: 'Client decision',
    body: 'The client approves or asks for changes in their portal.',
    state: 'client',
    label: 'Client review',
  },
  {
    title: 'Implementation',
    body: 'Approved decisions become committed, tracked work.',
    state: 'future',
    label: 'Next week',
  },
];

const SECURITY = [
  {
    title: 'Tenant isolation',
    body: 'Each client organisation sees only its own engagements, files and decisions.',
  },
  {
    title: 'Audit by default',
    body: 'Views, exports, approvals and permission changes are logged and exportable.',
  },
  {
    title: 'Clean offboarding',
    body: 'When an engagement ends, access closes and your retention rules apply.',
  },
] as const;

const STORY_MEASURES = [
  {
    icon: 'pulse',
    label: 'Hours saved preparing each steering pack',
    hint: 'Measured with the design partner and published with the story.',
  },
  {
    icon: 'link',
    label: 'Decisions traced back to their evidence',
    hint: 'Counted from the partner’s decision register at publication.',
  },
] as const;

function Checklist({ items }: { items: readonly string[] }) {
  return (
    <ul className="tm-consult-checks">
      {items.map((item) => (
        <li key={item}>
          <WebIcon name="check" size={14} />
          {item}
        </li>
      ))}
    </ul>
  );
}

export function ConsultanciesPage() {
  return (
    <div className="tm-consult">
      {/* 2 · Hero */}
      <WebSection className="tm-consult-hero" aria-labelledby="consult-hero-title">
        <div className="tm-consult-hero__grid">
          <div className="tm-consult-hero__text">
            <Badge mono className="tm-consult-hero__eyebrow">
              For consultancies
            </Badge>
            <h1 id="consult-hero-title" className="tm-consult-hero__title">
              Make every recommendation traceable to a decision.
            </h1>
            <p className="tm-consult-hero__lede">
              Engagements, findings, decisions and client sign-off in one auditable story.
            </p>
            <div className="tm-consult-hero__actions">
              <ButtonLink href="/sign-in" tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                Book a demo
              </ButtonLink>
            </div>
            <p className="tm-consult-hero__note">No credit card · Client users are always free</p>
          </div>
          <DecisionRegisterScene />
        </div>
      </WebSection>

      {/* 3 · Pain → answer */}
      <WebSection tone="sunken" aria-labelledby="consult-pain-title">
        <SectionHeader
          align="center"
          eyebrow="Why consultancies switch"
          title="Advice is only as good as its paper trail."
          lede="The three problems we hear most from partners, and how TManage answers each one."
          id="consult-pain-title"
        />
        <ul className="tm-consult-pains">
          {PAINS.map((item) => (
            <li key={item.pain} className="tm-consult-pain">
              <Badge>Today</Badge>
              <p className="tm-consult-pain__was">
                <span className="tm-visually-hidden">Problem: </span>
                {item.pain}
              </p>
              <div className="tm-consult-pain__answer">
                <p className="tm-consult-pain__with">
                  <WebIcon name="check" size={14} />
                  With TManage
                </p>
                <h3 className="tm-consult-pain__title">{item.answer}</h3>
                <p className="tm-consult-pain__body">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 4 · Workflow */}
      <WebSection aria-labelledby="consult-flow-title">
        <SectionHeader
          align="center"
          eyebrow="How an engagement flows"
          title="From first interview to signed-off change."
          lede="Each stage hands the next one its evidence, so nothing is retyped and nothing is lost."
          id="consult-flow-title"
        />
        <ol className="tm-consult-flow">
          {STEPS.map((step, index) => (
            <li key={step.title} className="tm-consult-flow__item">
              <div className="tm-consult-step">
                <span className="tm-consult-mono">{String(index + 1).padStart(2, '0')}</span>
                <StateCapsule state={step.state}>{step.label}</StateCapsule>
                <h3 className="tm-consult-step__title">{step.title}</h3>
                <p className="tm-consult-step__body">{step.body}</p>
              </div>
              {index < STEPS.length - 1 ? (
                <span className="tm-consult-flow__arrow" aria-hidden="true">
                  <WebIcon name="arrow-right" size={14} />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </WebSection>

      {/* 5 · Rows */}
      <WebSection className="tm-consult-rows" aria-label="What consultancies get">
        <FeatureRow
          label="Engagements"
          title="Engagements with a clear spine."
          body="Workstreams, findings and deliverables sit on one timeline, so a new team member can read the whole story in ten minutes."
          link={{ label: 'Explore projects', href: '/features/work' }}
          visual={<EngagementStoryScene />}
        >
          <Checklist
            items={[
              'Workstreams and milestones per engagement',
              'Findings linked to the work that produced them',
              'One Work Story from kickoff to close',
            ]}
          />
        </FeatureRow>
        <FeatureRow
          reverse
          label="Evidence"
          title="Evidence your partners can defend."
          body="Each recommendation carries its sources, its reviewers and its approval history. When a client asks why, the answer is one click away."
          link={{ label: 'Explore docs & decisions', href: '/features/knowledge' }}
          visual={<DecisionDetailScene />}
        >
          <Checklist
            items={[
              'Decisions with owner, date and rationale',
              'Versioned approvals that are never overwritten',
              'A complete audit trail for every change',
            ]}
          />
        </FeatureRow>
        <FeatureRow
          label="Reporting"
          title="Steering-committee updates in minutes."
          body="Health, risks and open client decisions roll up on their own. Review, add a line of context and send."
          link={{ label: 'Explore insights', href: '/features/insights' }}
          visual={<SteeringHealthScene />}
        >
          <Checklist
            items={[
              'Project health without status meetings',
              'Open client decisions surfaced first',
              'Updates your client reads in their portal',
            ]}
          />
        </FeatureRow>
      </WebSection>

      {/* 6 · Security callout */}
      <WebSection spacing="flush" className="tm-consult-secure-section">
        <div className="tm-consult-secure">
          <div className="tm-consult-secure__text">
            <Eyebrow tone="ink">Security &amp; trust</Eyebrow>
            <h2 className="tm-consult-secure__title">Your clients&rsquo; data stays theirs.</h2>
            <p className="tm-consult-secure__lede">
              Every client organisation is isolated, every access is logged, and offboarding is a
              checklist, not a hope.
            </p>
            <ButtonLink href="/security" tone="lime">
              Read about security
            </ButtonLink>
          </div>
          <ul className="tm-consult-secure__list">
            {SECURITY.map((item) => (
              <li key={item.title} className="tm-consult-secure__card">
                <WebIcon name="check" size={14} />
                <span>
                  <span className="tm-consult-secure__card-title">{item.title}</span>
                  <span className="tm-consult-secure__card-body">{item.body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </WebSection>

      {/* 7 · Story card (a consented design-partner story is published here) */}
      <WebSection tone="sunken" aria-label="Customer story">
        <figure className="tm-consult-story-card">
          <div className="tm-consult-story-card__quote">
            <Badge>Customer story · coming soon</Badge>
            <blockquote className="tm-consult-story-card__text">
              <p>
                “A design-partner consultancy will tell how a shared decision register changed their
                steering meetings.”
              </p>
            </blockquote>
            <figcaption className="tm-consult-story-card__by">
              <Avatar name="Partner name" audience="client" decorative />
              <span>
                <span className="tm-consult-story-card__name">Partner name</span>
                <span className="tm-consult-story-card__org">
                  Partner, design-partner consultancy
                </span>
              </span>
            </figcaption>
          </div>
          <dl className="tm-consult-story-card__facts">
            {STORY_MEASURES.map((item) => (
              <div key={item.label}>
                <dt>
                  <IconOrb icon={item.icon} tone="lime" />
                  <span className="tm-visually-hidden">What the story will measure:</span>
                </dt>
                <dd>
                  <span className="tm-consult-story-card__label">{item.label}</span>
                  <span className="tm-consult-story-card__hint">{item.hint}</span>
                </dd>
              </div>
            ))}
          </dl>
        </figure>
      </WebSection>

      {/* 8 · CTA band with the Delivery risk saved view, as drawn */}
      <CtaBand
        title="Bring your next engagement into one story."
        lede="Start free with your team. Invite your client when the first recommendation is ready."
      />
    </div>
  );
}
