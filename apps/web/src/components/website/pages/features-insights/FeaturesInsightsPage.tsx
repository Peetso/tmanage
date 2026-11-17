'use client';

import type { ReactNode } from 'react';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { ButtonLink, Eyebrow, cx } from '../../primitives';
import { DeliveryRiskScene } from '../../ProductScenes';
import { CtaBand, ProductVisualFrame, SectionHeader, WebSection } from '../../sections';
import {
  AssistantScene,
  AutomationScene,
  PortfolioScene,
  PulseScene,
  ScoreWorkingScene,
  WorkloadScene,
} from './scenes';
import './features-insights.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { CompareLinks } from '../alternatives/CompareLinks';

/**
 * Features · Insights & automations (WEB-06, SITE-SPEC "PAGE: Features · Insights &
 * automations"). Matches the round-2 Figma frame "WEB-06" (node 308:31) section for section:
 * hero with the portfolio card and anchor pills (the first one on), Explainable health, Pulse on
 * a lime frame, the centred Workload band, the Automations ink panel, the AI assistant row, then
 * the standard CTA band. Every pill points at the section that shows that view: Portfolio and
 * Approval cycle land on the hero's portfolio card and the health breakdown respectively.
 */

const PILLS: readonly { id: string; labelKey: MessageKey }[] = [
  { id: 'health', labelKey: 'FeaturesInsightsPage.pillHealth' },
  { id: 'portfolio', labelKey: 'FeaturesInsightsPage.pillPortfolio' },
  { id: 'approval-cycle', labelKey: 'FeaturesInsightsPage.pillApprovalCycle' },
  { id: 'automations', labelKey: 'FeaturesInsightsPage.pillAutomations' },
  { id: 'assistant', labelKey: 'FeaturesInsightsPage.pillAssistant' },
];

function InsightsRow({
  id,
  eyebrow,
  title,
  body,
  visual,
  reverse = false,
  tone = 'sunken',
  visualId,
}: {
  id: string;
  eyebrow: string;
  title: ReactNode;
  body: ReactNode;
  visual: ReactNode;
  reverse?: boolean;
  tone?: 'sunken' | 'lime';
  visualId?: string;
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
      </div>
      <div id={visualId} className="tm-web-fi-visual-anchor">
        <ProductVisualFrame
          className={cx('tm-web-fi-visual', tone === 'lime' && 'tm-web-fi-visual--lime')}
        >
          {visual}
        </ProductVisualFrame>
      </div>
    </section>
  );
}

export function FeaturesInsightsPage() {
  const t = useT();
  return (
    <div className="tm-web-fi">
      {/* 2 · Hero */}
      <WebSection spacing="flush" className="tm-web-fi-hero" aria-labelledby="fi-hero-title">
        <div className="tm-web-fi-hero__grid">
          <div className="tm-web-fi-hero__text">
            <SectionHeader
              eyebrow={t('FeaturesInsightsPage.heroEyebrow')}
              title={t('FeaturesInsightsPage.heroTitle')}
              lede={t('FeaturesInsightsPage.heroLede')}
              as="h1"
              size="page"
              id="fi-hero-title"
            />
            <div className="tm-web-fi-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('FeaturesInsightsPage.startFree')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                {t('FeaturesInsightsPage.bookDemo')}
              </ButtonLink>
            </div>
            <nav className="tm-web-fi-pills" aria-label={t('FeaturesInsightsPage.pillsAria')}>
              {PILLS.map((pill, index) => (
                <a
                  key={pill.id}
                  href={`#${pill.id}`}
                  className={cx('tm-web-chip', 'tm-web-fi-pill', index === 0 && 'tm-web-chip--on')}
                >
                  {t(pill.labelKey)}
                </a>
              ))}
            </nav>
          </div>
          <div className="tm-web-fi-hero__visual" id="portfolio">
            <PortfolioScene />
          </div>
        </div>
      </WebSection>

      {/* 3 · Explainable health; 4 · Pulse */}
      <WebSection className="tm-web-fi-stack">
        <InsightsRow
          id="health"
          eyebrow={t('FeaturesInsightsPage.healthEyebrow')}
          title={t('FeaturesInsightsPage.healthTitle')}
          body={t('FeaturesInsightsPage.healthBody')}
          visual={<ScoreWorkingScene />}
          visualId="approval-cycle"
        />

        <InsightsRow
          id="pulse"
          eyebrow={t('FeaturesInsightsPage.pulseEyebrow')}
          title={t('FeaturesInsightsPage.pulseTitle')}
          body={t('FeaturesInsightsPage.pulseBody')}
          visual={<PulseScene />}
          reverse
          tone="lime"
        />
      </WebSection>

      {/* 5 · No surveillance (paper/150 band) */}
      <WebSection tone="sunken" aria-labelledby="fi-fair-title">
        <div className="tm-web-fi-fair">
          <SectionHeader
            align="center"
            eyebrow={t('FeaturesInsightsPage.workloadEyebrow')}
            title={t('FeaturesInsightsPage.workloadTitle')}
            lede={t('FeaturesInsightsPage.workloadLede')}
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
              eyebrow={t('FeaturesInsightsPage.automationsEyebrow')}
              title={t('FeaturesInsightsPage.automationsTitle')}
              lede={t('FeaturesInsightsPage.automationsLede')}
            />
            <ButtonLink href={SIGN_UP_HREF} tone="lime">
              {t('FeaturesInsightsPage.automationsSeeTemplates')}
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
          eyebrow={t('FeaturesInsightsPage.assistantEyebrow')}
          title={t('FeaturesInsightsPage.assistantTitle')}
          body={t('FeaturesInsightsPage.assistantBody')}
          visual={<AssistantScene />}
        />
      </WebSection>

      {/* 8 · CTA band (9 · Footer comes from the layout) */}
      {/* This page keeps object titles in Latin (see `scenes.tsx`), so the CTA crop's deliverable
          row does too, instead of the catalog's translated title. */}
      <CompareLinks topic="features-insights" />

      <CtaBand
        title={t('FeaturesInsightsPage.ctaApprovalTitle')}
        visual={<DeliveryRiskScene deliverable="DEL · Homepage Concept v2" />}
      />
    </div>
  );
}
