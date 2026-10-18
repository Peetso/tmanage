'use client';

import type { ReactNode } from 'react';
import { ArrowLink, ButtonLink, Eyebrow, cx } from '../../primitives';
import { CtaBand, ProductVisualFrame, SectionHeader, WebSection } from '../../sections';
import {
  ApprovalCycleScene,
  AssistantScene,
  AutomationScene,
  HealthCropScene,
  PortfolioScene,
  PulseScene,
  ScoreWorkingScene,
  StagesScene,
  WorkloadScene,
} from './scenes';
import './features-insights.css';

/**
 * Features · Insights & automations (WEB-06, SITE-SPEC "PAGE: Features · Insights &
 * automations"). No Figma frame exists for this page; it follows the designed sibling
 * Features · Docs, decisions & approvals (shots/05-features-knowledge.png) section for section:
 * a hero with a floating product card and anchor pills (the first one on), alternating rows with
 * the dotted mono eyebrow on paper/150 frames, a paper/150 band, an ink panel for the signature
 * feature, then the CTA band. Every pill points at a section of the same name.
 */

const PILLS = [
  { id: 'health', label: 'Project health' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'approval-cycle', label: 'Approval cycle' },
  { id: 'automations', label: 'Automations' },
  { id: 'assistant', label: 'AI assistant' },
] as const;

const TEMPLATES: readonly string[] = [
  'Remind a reviewer',
  'Move a milestone',
  'Notify the client channel',
];

function InsightsRow({
  id,
  eyebrow,
  title,
  body,
  visual,
  reverse = false,
  tone = 'sunken',
  children,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  body: ReactNode;
  visual: ReactNode;
  reverse?: boolean;
  tone?: 'sunken' | 'lime';
  children?: ReactNode;
}) {
  const headingId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cx(
        'tm-web-feature',
        'tm-web-fi-row-section',
        reverse && 'tm-web-feature--reverse',
      )}
    >
      <div className="tm-web-feature__text">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={headingId} className="tm-web-feature__title">
          {title}
        </h2>
        <p className="tm-web-feature__body">{body}</p>
        {children}
      </div>
      <ProductVisualFrame
        className={cx('tm-web-fi-visual', tone === 'lime' && 'tm-web-fi-visual--lime')}
      >
        {visual}
      </ProductVisualFrame>
    </section>
  );
}

function InsightsCard({
  id,
  eyebrow,
  title,
  body,
  visual,
}: {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  visual: ReactNode;
}) {
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} className="tm-web-fi-pair__card">
      <div className="tm-web-fi-pair__text">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={headingId} className="tm-web-fi-pair__title">
          {title}
        </h2>
        <p className="tm-web-fi-pair__body">{body}</p>
      </div>
      {visual}
    </section>
  );
}

export function FeaturesInsightsPage() {
  return (
    <div className="tm-web-fi">
      {/* 2 · Hero */}
      <WebSection spacing="flush" className="tm-web-fi-hero" aria-labelledby="fi-hero-title">
        <div className="tm-web-fi-hero__grid">
          <div className="tm-web-fi-hero__text">
            <SectionHeader
              eyebrow="Features · See & automate"
              title="Health you can explain. Automation you can trust."
              lede="Every score drills into the work behind it. Every automation shows what it will do before it runs."
              as="h1"
              size="page"
              id="fi-hero-title"
            />
            <div className="tm-web-fi-hero__actions">
              <ButtonLink href="/sign-in" tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                Book a demo
              </ButtonLink>
            </div>
            <nav className="tm-web-fi-pills" aria-label="On this page">
              {PILLS.map((pill, index) => (
                <a
                  key={pill.id}
                  href={`#${pill.id}`}
                  className={cx('tm-web-chip', 'tm-web-fi-pill', index === 0 && 'tm-web-chip--on')}
                >
                  {pill.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="tm-web-fi-hero__visual">
            <PortfolioScene />
          </div>
        </div>
      </WebSection>

      {/* 3 · Explainable health, then its two views: portfolio and approval cycle; 4 · Pulse */}
      <WebSection className="tm-web-fi-stack">
        <InsightsRow
          id="health"
          eyebrow="Explainable health"
          title="Scores that show their working."
          body="Health, risk and forecast link to the tasks, approvals and dates that produced them."
          visual={<ScoreWorkingScene />}
        >
          <ArrowLink href="/product" underline={false}>
            See project health in the product
          </ArrowLink>
        </InsightsRow>

        <div className="tm-web-fi-pair">
          <InsightsCard
            id="portfolio"
            eyebrow="Portfolio"
            title="Every project, exceptions first."
            body="Blocked work and returned approvals rise to the top, and every row opens the evidence behind it."
            visual={<StagesScene />}
          />
          <InsightsCard
            id="approval-cycle"
            eyebrow="Approval cycle"
            title="See where approvals wait."
            body="Time to a client decision, per project and per deliverable, with the item that is holding it."
            visual={<ApprovalCycleScene />}
          />
        </div>

        <InsightsRow
          id="pulse"
          eyebrow="Pulse"
          title="A weekly update drafted for you, published by a person."
          body="Pulse drafts the client update from current work. A manager edits and publishes — never automatically."
          visual={<PulseScene />}
          reverse
          tone="lime"
        >
          <ArrowLink href="/client-portal" underline={false}>
            How clients see it
          </ArrowLink>
        </InsightsRow>
      </WebSection>

      {/* 5 · No surveillance (paper/150 band) */}
      <WebSection tone="sunken" aria-labelledby="fi-fair-title">
        <div className="tm-web-fi-fair">
          <SectionHeader
            eyebrow="Workload"
            title="Capacity is about commitments, not people scores."
            lede="TManage never ranks individual productivity. Workload shows commitments and constraints so managers can plan fairly."
            id="fi-fair-title"
          />
          <div className="tm-web-fi-fair__visual">
            <WorkloadScene />
          </div>
        </div>
      </WebSection>

      {/* 6 · Automations (ink panel, signature) */}
      <WebSection aria-labelledby="fi-auto-title">
        <div className="tm-web-fi-panel" id="automations">
          <div className="tm-web-fi-panel__text">
            <SectionHeader
              tone="ink"
              size="page"
              id="fi-auto-title"
              eyebrow="Automations"
              title="Remove the repeat coordination."
              lede="Start from templates: remind a reviewer, move a milestone, notify the client channel. Test with a dry run and see which identity will act before you switch it on."
            />
            <ul className="tm-web-fi-panel__templates" aria-label="Automation templates">
              {TEMPLATES.map((t) => (
                <li key={t} className="tm-web-fi-panel__template">
                  {t}
                </li>
              ))}
            </ul>
            <ButtonLink href="/sign-in" tone="lime">
              Try a template
            </ButtonLink>
          </div>
          <div className="tm-web-fi-panel__visual">
            <AutomationScene />
          </div>
        </div>
      </WebSection>

      {/* 7 · AI assistant */}
      <WebSection className="tm-web-fi-last">
        <InsightsRow
          id="assistant"
          eyebrow="AI assistant"
          title="An assistant that cites, never acts alone."
          body="Ask about your projects and get answers with sources. It cannot publish, approve, invite or delete."
          visual={<AssistantScene />}
        >
          <ArrowLink href="/security" underline={false}>
            How we handle your data
          </ArrowLink>
        </InsightsRow>
      </WebSection>

      {/* 8 · CTA band (9 · Footer comes from the layout) */}
      <CtaBand
        title="Know why a project slips before your client asks."
        lede="Start free with your team. Health, Pulse and automation templates are there from day one."
        visual={<HealthCropScene />}
      />
    </div>
  );
}
