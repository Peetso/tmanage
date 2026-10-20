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
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { useT } from '../../../../lib/i18n/use-t';

/**
 * Solutions · Agencies & studios (WEB-08, SITE-SPEC "PAGE: Solutions · Agencies & studios").
 * No Figma frame exists for this page; it follows the designed sibling Solutions · Consultancies
 * section for section: hero + product visual, pain → answer cards on paper/150, a five-step
 * workflow strip, three alternating rows, template cards, a design-partner story, the CTA band.
 */

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
  const t = useT();

  const STORY_FACTS: readonly { icon: WebIconName; label: string; hint: string }[] = [
    {
      icon: 'calendar',
      label: t('SolutionsAgenciesPage.storyFact1Label'),
      hint: t('SolutionsAgenciesPage.storyFact1Hint'),
    },
    {
      icon: 'layers',
      label: t('SolutionsAgenciesPage.storyFact2Label'),
      hint: t('SolutionsAgenciesPage.storyFact2Hint'),
    },
  ];

  const PAINS: readonly { pain: string; answer: string; body: string }[] = [
    {
      pain: t('SolutionsAgenciesPage.pain1Pain'),
      answer: t('SolutionsAgenciesPage.pain1Answer'),
      body: t('SolutionsAgenciesPage.pain1Body'),
    },
    {
      pain: t('SolutionsAgenciesPage.pain2Pain'),
      answer: t('SolutionsAgenciesPage.pain2Answer'),
      body: t('SolutionsAgenciesPage.pain2Body'),
    },
    {
      pain: t('SolutionsAgenciesPage.pain3Pain'),
      answer: t('SolutionsAgenciesPage.pain3Answer'),
      body: t('SolutionsAgenciesPage.pain3Body'),
    },
  ];

  const STEPS: readonly { title: string; body: string; state: CapsuleState; label: string }[] = [
    {
      title: t('SolutionsAgenciesPage.step1Title'),
      body: t('SolutionsAgenciesPage.step1Body'),
      state: 'done',
      label: t('SolutionsAgenciesPage.step1Label'),
    },
    {
      title: t('SolutionsAgenciesPage.step2Title'),
      body: t('SolutionsAgenciesPage.step2Body'),
      state: 'done',
      label: t('SolutionsAgenciesPage.step2Label'),
    },
    {
      title: t('SolutionsAgenciesPage.step3Title'),
      body: t('SolutionsAgenciesPage.step3Body'),
      state: 'current',
      label: t('SolutionsAgenciesPage.step3Label'),
    },
    {
      title: t('SolutionsAgenciesPage.step4Title'),
      body: t('SolutionsAgenciesPage.step4Body'),
      state: 'client',
      label: t('SolutionsAgenciesPage.step4Label'),
    },
    {
      title: t('SolutionsAgenciesPage.step5Title'),
      body: t('SolutionsAgenciesPage.step5Body'),
      state: 'future',
      label: t('SolutionsAgenciesPage.step5Label'),
    },
  ];

  const TEMPLATES: readonly {
    title: string;
    body: string;
    icon: WebIconName;
    facts: readonly string[];
  }[] = [
    {
      title: t('SolutionsAgenciesPage.template1Title'),
      body: t('SolutionsAgenciesPage.template1Body'),
      icon: 'globe',
      facts: [t('SolutionsAgenciesPage.template1Fact1'), t('SolutionsAgenciesPage.template1Fact2')],
    },
    {
      title: t('SolutionsAgenciesPage.template2Title'),
      body: t('SolutionsAgenciesPage.template2Body'),
      icon: 'pencil',
      facts: [t('SolutionsAgenciesPage.template2Fact1'), t('SolutionsAgenciesPage.template2Fact2')],
    },
    {
      title: t('SolutionsAgenciesPage.template3Title'),
      body: t('SolutionsAgenciesPage.template3Body'),
      icon: 'layers',
      facts: [t('SolutionsAgenciesPage.template3Fact1'), t('SolutionsAgenciesPage.template3Fact2')],
    },
  ];

  return (
    <>
      {/* 2 · Hero */}
      <WebSection spacing="compact" className="tm-web-ag-hero" aria-labelledby="ag-hero-title">
        <div className="tm-web-ag-hero__grid">
          <div className="tm-web-ag-hero__text">
            <Badge mono className="tm-web-ag-hero__eyebrow">
              {t('SolutionsAgenciesPage.heroEyebrow')}
            </Badge>
            <SectionHeader
              title={t('SolutionsAgenciesPage.heroTitle')}
              lede={t('SolutionsAgenciesPage.heroLede')}
              as="h1"
              size="page"
              id="ag-hero-title"
            />
            <div className="tm-web-ag-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('SolutionsAgenciesPage.startFree')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                {t('SolutionsAgenciesPage.bookDemo')}
              </ButtonLink>
            </div>
            <p className="tm-web-ag-hero__note">{t('SolutionsAgenciesPage.heroNote')}</p>
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
          eyebrow={t('SolutionsAgenciesPage.painEyebrow')}
          title={t('SolutionsAgenciesPage.painTitle')}
          lede={t('SolutionsAgenciesPage.painLede')}
          id="ag-pain-title"
        />
        <ul className="tm-web-ag-pains">
          {PAINS.map((item) => (
            <li key={item.answer} className="tm-web-ag-pain">
              <Badge>{t('SolutionsAgenciesPage.today')}</Badge>
              <p className="tm-web-ag-pain__problem">{item.pain}</p>
              <div className="tm-web-ag-pain__answer">
                <p className="tm-web-ag-pain__with">
                  <WebIcon name="check" size={14} />
                  {t('SolutionsAgenciesPage.withTManage')}
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
          eyebrow={t('SolutionsAgenciesPage.flowEyebrow')}
          title={t('SolutionsAgenciesPage.flowTitle')}
          lede={t('SolutionsAgenciesPage.flowLede')}
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
      <WebSection aria-label={t('SolutionsAgenciesPage.rowsLabel')} className="tm-web-ag-rows">
        <AgRow
          label={t('SolutionsAgenciesPage.row1Label')}
          title={t('SolutionsAgenciesPage.row1Title')}
          body={t('SolutionsAgenciesPage.row1Body')}
          link={{ label: t('SolutionsAgenciesPage.row1Link'), href: '/client-portal' }}
          visual={<ClientBoundariesScene />}
        >
          <Checklist
            items={[
              t('SolutionsAgenciesPage.row1Check1'),
              t('SolutionsAgenciesPage.row1Check2'),
              t('SolutionsAgenciesPage.row1Check3'),
            ]}
          />
        </AgRow>
        <AgRow
          reverse
          label={t('SolutionsAgenciesPage.row2Label')}
          title={t('SolutionsAgenciesPage.row2Title')}
          body={t('SolutionsAgenciesPage.row2Body')}
          link={{ label: t('SolutionsAgenciesPage.row2Link'), href: '/features/knowledge' }}
          visual={<CreativeReviewScene />}
        >
          <Checklist
            items={[
              t('SolutionsAgenciesPage.row2Check1'),
              t('SolutionsAgenciesPage.row2Check2'),
              t('SolutionsAgenciesPage.row2Check3'),
            ]}
          />
        </AgRow>
        <AgRow
          label={t('SolutionsAgenciesPage.row3Label')}
          title={t('SolutionsAgenciesPage.row3Title')}
          body={t('SolutionsAgenciesPage.row3Body')}
          link={{ label: t('SolutionsAgenciesPage.row3Link'), href: '/features/work' }}
          visual={<RetainerPlanScene />}
        >
          <Checklist
            items={[
              t('SolutionsAgenciesPage.row3Check1'),
              t('SolutionsAgenciesPage.row3Check2'),
              t('SolutionsAgenciesPage.row3Check3'),
            ]}
          />
        </AgRow>
      </WebSection>

      {/* 6 · Template cards */}
      <WebSection tone="sunken" aria-labelledby="ag-templates-title">
        <SectionHeader
          eyebrow={t('SolutionsAgenciesPage.templatesEyebrow')}
          title={t('SolutionsAgenciesPage.templatesTitle')}
          lede={t('SolutionsAgenciesPage.templatesLede')}
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
              <ArrowLink href={SIGN_UP_HREF} underline={false}>
                {t('SolutionsAgenciesPage.useTemplate')}
              </ArrowLink>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 7 · Story card (design-partner story, one white panel as on Consultancies) */}
      <WebSection
        aria-label={t('SolutionsAgenciesPage.storyLabel')}
        className="tm-web-ag-story-section"
      >
        <figure className="tm-web-ag-story">
          <div className="tm-web-ag-story__quote">
            <Badge>{t('SolutionsAgenciesPage.storyBadge')}</Badge>
            <blockquote className="tm-web-ag-story__text">
              <p>{t('SolutionsAgenciesPage.storyQuote')}</p>
            </blockquote>
            <figcaption className="tm-web-ag-story__by">
              <Avatar name="Studio lead" audience="client" decorative />
              <span>
                <span className="tm-web-ag-story__name">
                  {t('SolutionsAgenciesPage.storyName')}
                </span>
                <span className="tm-web-ag-story__org">{t('SolutionsAgenciesPage.storyOrg')}</span>
              </span>
            </figcaption>
          </div>
          <ul
            className="tm-web-ag-story__facts"
            aria-label={t('SolutionsAgenciesPage.storyFactsLabel')}
          >
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
                {t('SolutionsAgenciesPage.ctaTitle')}
              </h2>
              <p className="tm-web-cta__lede tm-web-ag-cta__lede">
                {t('SolutionsAgenciesPage.ctaLede')}
              </p>
              <div className="tm-web-cta__actions tm-web-ag-cta__actions">
                <ButtonLink href={SIGN_UP_HREF} tone="lime">
                  {t('SolutionsAgenciesPage.startFree')}
                </ButtonLink>
                <ButtonLink href="/contact" tone="outline-ink">
                  {t('SolutionsAgenciesPage.bookDemo')}
                </ButtonLink>
              </div>
              <p className="tm-web-cta__note tm-web-ag-cta__note">
                {t('SolutionsAgenciesPage.heroNote')}
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
