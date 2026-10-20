'use client';

import type { ReactNode } from 'react';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
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
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * Features · Insights & automations (WEB-06, SITE-SPEC "PAGE: Features · Insights &
 * automations"). No Figma frame exists for this page; it follows the designed sibling
 * Features · Docs, decisions & approvals (shots/05-features-knowledge.png) section for section:
 * a hero with a floating product card and anchor pills (the first one on), alternating rows with
 * the dotted mono eyebrow on paper/150 frames, a paper/150 band, an ink panel for the signature
 * feature, then the CTA band. Every pill points at a section of the same name.
 */

const PILLS: readonly { id: string; labelKey: MessageKey }[] = [
  { id: 'health', labelKey: 'FeaturesInsightsPage.pillHealth' },
  { id: 'portfolio', labelKey: 'FeaturesInsightsPage.pillPortfolio' },
  { id: 'approval-cycle', labelKey: 'FeaturesInsightsPage.pillApprovalCycle' },
  { id: 'automations', labelKey: 'FeaturesInsightsPage.pillAutomations' },
  { id: 'assistant', labelKey: 'FeaturesInsightsPage.pillAssistant' },
];

const TEMPLATES: readonly MessageKey[] = [
  'FeaturesInsightsPage.templateRemind',
  'FeaturesInsightsPage.templateMove',
  'FeaturesInsightsPage.templateNotify',
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
          <div className="tm-web-fi-hero__visual">
            <PortfolioScene />
          </div>
        </div>
      </WebSection>

      {/* 3 · Explainable health, then its two views: portfolio and approval cycle; 4 · Pulse */}
      <WebSection className="tm-web-fi-stack">
        <InsightsRow
          id="health"
          eyebrow={t('FeaturesInsightsPage.healthEyebrow')}
          title={t('FeaturesInsightsPage.healthTitle')}
          body={t('FeaturesInsightsPage.healthBody')}
          visual={<ScoreWorkingScene />}
        >
          <ArrowLink href="/product" underline={false}>
            {t('FeaturesInsightsPage.healthLink')}
          </ArrowLink>
        </InsightsRow>

        <div className="tm-web-fi-pair">
          <InsightsCard
            id="portfolio"
            eyebrow={t('FeaturesInsightsPage.portfolioEyebrow')}
            title={t('FeaturesInsightsPage.portfolioTitle')}
            body={t('FeaturesInsightsPage.portfolioBody')}
            visual={<StagesScene />}
          />
          <InsightsCard
            id="approval-cycle"
            eyebrow={t('FeaturesInsightsPage.approvalCycleEyebrow')}
            title={t('FeaturesInsightsPage.approvalCycleTitle')}
            body={t('FeaturesInsightsPage.approvalCycleBody')}
            visual={<ApprovalCycleScene />}
          />
        </div>

        <InsightsRow
          id="pulse"
          eyebrow={t('FeaturesInsightsPage.pulseEyebrow')}
          title={t('FeaturesInsightsPage.pulseTitle')}
          body={t('FeaturesInsightsPage.pulseBody')}
          visual={<PulseScene />}
          reverse
          tone="lime"
        >
          <ArrowLink href="/client-portal" underline={false}>
            {t('FeaturesInsightsPage.pulseLink')}
          </ArrowLink>
        </InsightsRow>
      </WebSection>

      {/* 5 · No surveillance (paper/150 band) */}
      <WebSection tone="sunken" aria-labelledby="fi-fair-title">
        <div className="tm-web-fi-fair">
          <SectionHeader
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
            <ul
              className="tm-web-fi-panel__templates"
              aria-label={t('FeaturesInsightsPage.templatesAria')}
            >
              {TEMPLATES.map((templateKey) => (
                <li key={templateKey} className="tm-web-fi-panel__template">
                  {t(templateKey)}
                </li>
              ))}
            </ul>
            <ButtonLink href={SIGN_UP_HREF} tone="lime">
              {t('FeaturesInsightsPage.automationsTry')}
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
        >
          <ArrowLink href="/security" underline={false}>
            {t('FeaturesInsightsPage.assistantLink')}
          </ArrowLink>
        </InsightsRow>
      </WebSection>

      {/* 8 · CTA band (9 · Footer comes from the layout) */}
      <CtaBand
        title={t('FeaturesInsightsPage.ctaTitle')}
        lede={t('FeaturesInsightsPage.ctaLede')}
        visual={<HealthCropScene />}
      />
    </div>
  );
}
