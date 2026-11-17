'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
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
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { CompareLinks } from '../alternatives/CompareLinks';

/**
 * Features · Docs, decisions & approvals (`/features/knowledge`) — SITE-SPEC "PAGE: Features ·
 * Docs, decisions & approvals", drawn in shots/05-features-knowledge.png. Composed from the
 * shared website layer; the only page-specific parts are the product scenes in `scenes.tsx`
 * and the layout rules in `features-knowledge.css`, all on Limeframe tokens.
 */

const ANCHORS = [
  { id: 'docs', labelKey: 'FeaturesKnowledgePage.anchorDocs' },
  { id: 'decisions', labelKey: 'FeaturesKnowledgePage.anchorDecisions' },
  { id: 'versions', labelKey: 'FeaturesKnowledgePage.anchorVersions' },
  { id: 'approvals', labelKey: 'FeaturesKnowledgePage.anchorApprovals' },
  { id: 'search', labelKey: 'FeaturesKnowledgePage.anchorSearch' },
] as const satisfies readonly { id: string; labelKey: MessageKey }[];

const FAQ: readonly { questionKey: MessageKey; answerKey: MessageKey }[] = [
  {
    questionKey: 'FeaturesKnowledgePage.faqCoeditQ',
    answerKey: 'FeaturesKnowledgePage.faqCoeditA',
  },
  {
    questionKey: 'FeaturesKnowledgePage.faqDownloadQ',
    answerKey: 'FeaturesKnowledgePage.faqDownloadA',
  },
  {
    questionKey: 'FeaturesKnowledgePage.faqSelfApproveQ',
    answerKey: 'FeaturesKnowledgePage.faqSelfApproveA',
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
  const t = useT();
  const activeAnchor = useActiveAnchor();
  const stats: readonly StatProps[] = [
    {
      value: '1',
      unit: t('FeaturesKnowledgePage.statVersionUnit'),
      label: t('FeaturesKnowledgePage.statVersionLabel'),
      note: t('FeaturesKnowledgePage.statVersionNote'),
    },
    {
      value: '0',
      unit: t('FeaturesKnowledgePage.statTablesUnit'),
      label: t('FeaturesKnowledgePage.statTablesLabel'),
      note: t('FeaturesKnowledgePage.statTablesNote'),
    },
    {
      value: '3',
      unit: t('FeaturesKnowledgePage.statAudiencesUnit'),
      label: t('FeaturesKnowledgePage.statAudiencesLabel'),
      note: t('FeaturesKnowledgePage.statAudiencesNote'),
    },
  ];
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
              eyebrow={t('FeaturesKnowledgePage.heroEyebrow')}
              title={t('FeaturesKnowledgePage.heroTitle')}
              lede={t('FeaturesKnowledgePage.heroLede')}
            />
            <div className="tm-fk-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('FeaturesKnowledgePage.startFree')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                {t('FeaturesKnowledgePage.bookDemo')}
              </ButtonLink>
            </div>
            <nav className="tm-fk-anchors" aria-label={t('FeaturesKnowledgePage.anchorsAria')}>
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
                  {t(anchor.labelKey)}
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
          eyebrow={t('FeaturesKnowledgePage.docsEyebrow')}
          title={t('FeaturesKnowledgePage.docsTitle')}
          body={t('FeaturesKnowledgePage.docsBody')}
          visual={<ProjectBriefScene />}
        />
        <KnowledgeRow
          id="decisions"
          eyebrow={t('FeaturesKnowledgePage.decisionsEyebrow')}
          title={t('FeaturesKnowledgePage.decisionsTitle')}
          body={t('FeaturesKnowledgePage.decisionsBody')}
          visual={<DecisionScene />}
          reverse
          tone="lime"
        />
        <div className="tm-fk-stats">
          <StatBand stats={stats} />
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
              eyebrow={t('FeaturesKnowledgePage.versionsEyebrow')}
              title={t('FeaturesKnowledgePage.versionsTitle')}
              lede={t('FeaturesKnowledgePage.versionsLede')}
            />
            <ButtonLink href="/client-portal" tone="lime" className="tm-fk-ink__cta">
              {t('FeaturesKnowledgePage.versionsCta')}
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
          eyebrow={t('FeaturesKnowledgePage.previewEyebrow')}
          title={t('FeaturesKnowledgePage.previewTitle')}
          body={t('FeaturesKnowledgePage.previewBody')}
          visual={<PublicationPreviewScene />}
        />
        <KnowledgeRow
          id="search"
          eyebrow={t('FeaturesKnowledgePage.searchEyebrow')}
          title={t('FeaturesKnowledgePage.searchTitle')}
          body={t('FeaturesKnowledgePage.searchBody')}
          visual={<PermissionSearchScene />}
          reverse
        />
      </WebSection>

      {/* 8 · FAQ */}
      <WebSection spacing="flush" className="tm-fk-faq" aria-labelledby="fk-faq-title">
        <SectionHeader
          align="center"
          id="fk-faq-title"
          eyebrow={t('FeaturesKnowledgePage.faqEyebrow')}
          title={t('FeaturesKnowledgePage.faqTitle')}
          lede={t('FeaturesKnowledgePage.faqLede')}
        />
        <div className="tm-web-faq-list tm-fk-faq__list">
          {FAQ.map((item, index) => (
            <KnowledgeFaqRow
              key={item.questionKey}
              question={t(item.questionKey)}
              answer={t(item.answerKey)}
              defaultOpen={index === 0}
            />
          ))}
        </div>
      </WebSection>

      {/* 9 · CTA band */}
      <CompareLinks topic="features-knowledge" />

      <CtaBand
        title={
          <>
            {t('FeaturesKnowledgePage.ctaTitlePart1')}
            <br className="tm-fk-cta-break" />
            {t('FeaturesKnowledgePage.ctaTitlePart2')}
          </>
        }
        visual={<ClientApprovalScene />}
      />
    </div>
  );
}
