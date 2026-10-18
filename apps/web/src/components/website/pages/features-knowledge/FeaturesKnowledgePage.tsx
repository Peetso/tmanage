'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ButtonLink, Eyebrow, cx } from '../../primitives';
import { WebIcon } from '../../WebIcon';
import {
  CtaBand,
  ProductVisualFrame,
  SectionHeader,
  StatBand,
  WebSection,
  type FaqItem,
  type StatProps,
} from '../../sections';
import {
  ClientApprovalScene,
  DecisionRecordScene,
  DecisionScene,
  GovernedVersionScene,
  PermissionSearchScene,
  ProjectBriefScene,
  PublicationPreviewScene,
} from './scenes';
import './features-knowledge.css';

/**
 * Features · Docs, decisions & approvals (`/features/knowledge`) — SITE-SPEC "PAGE: Features ·
 * Docs, decisions & approvals", drawn in shots/05-features-knowledge.png. Composed from the
 * shared website layer; the only page-specific parts are the product scenes in `scenes.tsx`
 * and the layout rules in `features-knowledge.css`, all on Limeframe tokens.
 */

const ANCHORS = [
  { id: 'docs', label: 'Docs' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'versions', label: 'Files & versions' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'search', label: 'Search' },
] as const;

const STATS: readonly StatProps[] = [
  {
    value: '1',
    unit: 'version',
    label: 'approved per sign-off',
    note: 'Change the file and the approval resets to the new version.',
  },
  {
    value: '0',
    unit: 'pasted tables',
    label: 'status tables to keep current',
    note: 'Embedded tasks and milestones update themselves.',
  },
  {
    value: '3',
    unit: 'audiences',
    label: 'team, client or private, per block',
    note: 'Every block says who can read it before you publish.',
  },
];

const FAQ: readonly FaqItem[] = [
  {
    question: 'Is there real-time co-editing?',
    answer: 'Docs support comments and versions today; live co-editing is on the roadmap.',
  },
  {
    question: 'Which files can clients download?',
    answer: 'Only published, scanned versions, through short-lived links.',
  },
  {
    question: 'Can an author approve their own work?',
    answer: 'No. Internal review requires someone else.',
  },
];

type AnchorId = (typeof ANCHORS)[number]['id'];

/**
 * The hero pills follow the reader: the pill for the section that holds the upper third of the
 * viewport is the selected one (`aria-current="location"`). Above the first section the first
 * pill stays selected, as drawn.
 */
function useActiveAnchor(): AnchorId {
  const [active, setActive] = useState<AnchorId>(ANCHORS[0].id);
  useEffect(() => {
    const update = () => {
      const line = window.innerHeight / 3;
      let current: AnchorId = ANCHORS[0].id;
      for (const anchor of ANCHORS) {
        const el = document.getElementById(anchor.id);
        if (el && el.getBoundingClientRect().top <= line) current = anchor.id;
      }
      setActive(current);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('hashchange', update);
    };
  }, []);
  return active;
}

/** FAQ row as drawn on this page: a chevron that points down when closed and up when open. */
function KnowledgeFaqRow({
  question,
  answer,
  defaultOpen = false,
}: FaqItem & { defaultOpen?: boolean }) {
  return (
    <details className="tm-web-faq tm-fk-faq__row" open={defaultOpen}>
      <summary className="tm-web-faq__question">
        <span>{question}</span>
        <WebIcon name="chevron-down" className="tm-fk-faq__chevron" />
      </summary>
      <div className="tm-web-faq__answer">{answer}</div>
    </details>
  );
}

function KnowledgeRow({
  id,
  eyebrow,
  title,
  body,
  visual,
  reverse = false,
  tone = 'sunken',
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  body: ReactNode;
  visual: ReactNode;
  reverse?: boolean;
  tone?: 'sunken' | 'lime';
}) {
  const headingId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cx('tm-web-feature', 'tm-fk-row', reverse && 'tm-web-feature--reverse')}
    >
      <div className="tm-web-feature__text">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={headingId} className="tm-web-feature__title">
          {title}
        </h2>
        <p className="tm-web-feature__body">{body}</p>
      </div>
      <ProductVisualFrame className={cx('tm-fk-visual', tone === 'lime' && 'tm-fk-visual--lime')}>
        {visual}
      </ProductVisualFrame>
    </section>
  );
}

export function FeaturesKnowledgePage() {
  const activeAnchor = useActiveAnchor();
  return (
    <div className="tm-fk">
      {/* 2 · Hero */}
      <WebSection spacing="flush" className="tm-fk-hero" aria-labelledby="fk-hero-title">
        <div className="tm-fk-hero__grid">
          <div className="tm-fk-hero__text">
            <SectionHeader
              as="h1"
              size="page"
              id="fk-hero-title"
              eyebrow="Features · Know & approve"
              title="Context beside the work. Approval on the exact version."
              lede="Docs, a decision register and governed deliverables — so you can always answer who agreed to what, and when."
            />
            <div className="tm-fk-hero__actions">
              <ButtonLink href="/sign-in" tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                Book a demo
              </ButtonLink>
            </div>
            <nav className="tm-fk-anchors" aria-label="On this page">
              {ANCHORS.map((anchor) => (
                <a
                  key={anchor.id}
                  href={`#${anchor.id}`}
                  aria-current={activeAnchor === anchor.id ? 'location' : undefined}
                  className={cx(
                    'tm-web-chip',
                    'tm-fk-anchor',
                    activeAnchor === anchor.id && 'tm-web-chip--on',
                  )}
                >
                  {anchor.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="tm-fk-hero__visual">
            <DecisionRecordScene />
          </div>
        </div>
      </WebSection>

      {/* 3–4 · Docs and the decision register, then the product facts */}
      <WebSection className="tm-fk-stack">
        <KnowledgeRow
          id="docs"
          eyebrow="Docs"
          title="Docs with live links to the work."
          body="Briefs, wikis and templates embed tasks and milestones that stay current. No pasted status tables."
          visual={<ProjectBriefScene />}
        />
        <KnowledgeRow
          id="decisions"
          eyebrow="Decision register"
          title="Every decision, with who made it and why."
          body="Turn a message or meeting note into a decision with an owner, a date and the options you rejected."
          visual={<DecisionScene />}
          reverse
          tone="lime"
        />
        <div className="tm-fk-stats">
          <StatBand stats={STATS} />
        </div>
      </WebSection>

      {/* 5 · Governed versions (ink panel, signature) */}
      <WebSection spacing="flush" aria-labelledby="versions-title">
        <div className="tm-fk-ink" id="versions">
          <div className="tm-fk-ink__text">
            <SectionHeader
              tone="ink"
              size="page"
              id="versions-title"
              eyebrow="Governed versions"
              title="Approval means approval."
              lede="A reviewer approves one exact version. Change the file and the approval is invalidated — never silently carried over."
            />
            <ButtonLink href="/client-portal" tone="lime" className="tm-fk-ink__cta">
              See how approvals work
            </ButtonLink>
          </div>
          <div className="tm-fk-ink__visual">
            <GovernedVersionScene />
          </div>
        </div>
      </WebSection>

      {/* 6–7 · Publication preview and permission-aware search */}
      <WebSection className="tm-fk-stack">
        <KnowledgeRow
          id="approvals"
          eyebrow="Client preview"
          title="See exactly what your client will see before you send it."
          body="Preview the client projection. Internal comments and cost fields are never shared."
          visual={<PublicationPreviewScene />}
        />
        <KnowledgeRow
          id="search"
          eyebrow="Search"
          title="Search that respects permissions."
          body="Results cite the objects you are allowed to see — nothing more."
          visual={<PermissionSearchScene />}
          reverse
        />
      </WebSection>

      {/* 8 · FAQ */}
      <WebSection spacing="flush" className="tm-fk-faq" aria-labelledby="fk-faq-title">
        <SectionHeader
          align="center"
          id="fk-faq-title"
          eyebrow="FAQ"
          title="Questions, answered plainly."
          lede="What teams ask before they move documents, decisions and approvals into TManage."
        />
        <div className="tm-web-faq-list tm-fk-faq__list">
          {FAQ.map((item, index) => (
            <KnowledgeFaqRow key={item.question} {...item} defaultOpen={index === 0} />
          ))}
        </div>
      </WebSection>

      {/* 9 · CTA band */}
      <CtaBand
        title={
          <>
            Give every approval a name, a date
            <br className="tm-fk-cta-break" /> and a version.
          </>
        }
        visual={<ClientApprovalScene />}
      />
    </div>
  );
}
