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
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { useT } from '../../../../lib/i18n/use-t';

/**
 * Solutions · Consultancies (SITE-SPEC "PAGE: Solutions · Consultancies", Figma shot
 * 09-solutions-consultancies). Composed from the shared website layer; the only page-specific
 * parts are the pain → answer card, the workflow step card, the ink security callout, the story
 * card and the four product scenes, all drawn with Limeframe tokens in `consultancies.css`.
 */

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
  const t = useT();

  const PAINS = [
    {
      pain: t('ConsultanciesPage.pain1Pain'),
      answer: t('ConsultanciesPage.pain1Answer'),
      body: t('ConsultanciesPage.pain1Body'),
    },
    {
      pain: t('ConsultanciesPage.pain2Pain'),
      answer: t('ConsultanciesPage.pain2Answer'),
      body: t('ConsultanciesPage.pain2Body'),
    },
    {
      pain: t('ConsultanciesPage.pain3Pain'),
      answer: t('ConsultanciesPage.pain3Answer'),
      body: t('ConsultanciesPage.pain3Body'),
    },
  ] as const;

  const STEPS: readonly { title: string; body: string; state: CapsuleState; label: string }[] = [
    {
      title: t('ConsultanciesPage.step1Title'),
      body: t('ConsultanciesPage.step1Body'),
      state: 'done',
      label: t('ConsultanciesPage.step1Label'),
    },
    {
      title: t('ConsultanciesPage.step2Title'),
      body: t('ConsultanciesPage.step2Body'),
      state: 'done',
      label: t('ConsultanciesPage.step2Label'),
    },
    {
      title: t('ConsultanciesPage.step3Title'),
      body: t('ConsultanciesPage.step3Body'),
      state: 'current',
      label: t('ConsultanciesPage.step3Label'),
    },
    {
      title: t('ConsultanciesPage.step4Title'),
      body: t('ConsultanciesPage.step4Body'),
      state: 'client',
      label: t('ConsultanciesPage.step4Label'),
    },
    {
      title: t('ConsultanciesPage.step5Title'),
      body: t('ConsultanciesPage.step5Body'),
      state: 'future',
      label: t('ConsultanciesPage.step5Label'),
    },
  ];

  const SECURITY = [
    { title: t('ConsultanciesPage.security1Title'), body: t('ConsultanciesPage.security1Body') },
    { title: t('ConsultanciesPage.security2Title'), body: t('ConsultanciesPage.security2Body') },
    { title: t('ConsultanciesPage.security3Title'), body: t('ConsultanciesPage.security3Body') },
  ] as const;

  const STORY_MEASURES = [
    {
      icon: 'pulse',
      label: t('ConsultanciesPage.measure1Label'),
      hint: t('ConsultanciesPage.measure1Hint'),
    },
    {
      icon: 'link',
      label: t('ConsultanciesPage.measure2Label'),
      hint: t('ConsultanciesPage.measure2Hint'),
    },
  ] as const;

  return (
    <div className="tm-consult">
      {/* 2 · Hero */}
      <WebSection className="tm-consult-hero" aria-labelledby="consult-hero-title">
        <div className="tm-consult-hero__grid">
          <div className="tm-consult-hero__text">
            <Badge mono className="tm-consult-hero__eyebrow">
              {t('ConsultanciesPage.heroEyebrow')}
            </Badge>
            <h1 id="consult-hero-title" className="tm-consult-hero__title">
              {t('ConsultanciesPage.heroTitle')}
            </h1>
            <p className="tm-consult-hero__lede">{t('ConsultanciesPage.heroLede')}</p>
            <div className="tm-consult-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('ConsultanciesPage.startFree')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                {t('ConsultanciesPage.bookDemo')}
              </ButtonLink>
            </div>
            <p className="tm-consult-hero__note">{t('ConsultanciesPage.heroNote')}</p>
          </div>
          <DecisionRegisterScene />
        </div>
      </WebSection>

      {/* 3 · Pain → answer */}
      <WebSection tone="sunken" aria-labelledby="consult-pain-title">
        <SectionHeader
          align="center"
          eyebrow={t('ConsultanciesPage.painEyebrow')}
          title={t('ConsultanciesPage.painTitle')}
          lede={t('ConsultanciesPage.painLede')}
          id="consult-pain-title"
        />
        <ul className="tm-consult-pains">
          {PAINS.map((item) => (
            <li key={item.pain} className="tm-consult-pain">
              <Badge>{t('ConsultanciesPage.today')}</Badge>
              <p className="tm-consult-pain__was">
                <span className="tm-visually-hidden">{t('ConsultanciesPage.problemPrefix')}</span>
                {item.pain}
              </p>
              <div className="tm-consult-pain__answer">
                <p className="tm-consult-pain__with">
                  <WebIcon name="check" size={14} />
                  {t('ConsultanciesPage.withTManage')}
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
          eyebrow={t('ConsultanciesPage.flowEyebrow')}
          title={t('ConsultanciesPage.flowTitle')}
          lede={t('ConsultanciesPage.flowLede')}
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
      <WebSection className="tm-consult-rows" aria-label={t('ConsultanciesPage.rowsLabel')}>
        <FeatureRow
          label={t('ConsultanciesPage.row1Label')}
          title={t('ConsultanciesPage.row1Title')}
          body={t('ConsultanciesPage.row1Body')}
          link={{ label: t('ConsultanciesPage.row1Link'), href: '/features/work' }}
          visual={<EngagementStoryScene />}
        >
          <Checklist
            items={[
              t('ConsultanciesPage.row1Check1'),
              t('ConsultanciesPage.row1Check2'),
              t('ConsultanciesPage.row1Check3'),
            ]}
          />
        </FeatureRow>
        <FeatureRow
          reverse
          label={t('ConsultanciesPage.row2Label')}
          title={t('ConsultanciesPage.row2Title')}
          body={t('ConsultanciesPage.row2Body')}
          link={{ label: t('ConsultanciesPage.row2Link'), href: '/features/knowledge' }}
          visual={<DecisionDetailScene />}
        >
          <Checklist
            items={[
              t('ConsultanciesPage.row2Check1'),
              t('ConsultanciesPage.row2Check2'),
              t('ConsultanciesPage.row2Check3'),
            ]}
          />
        </FeatureRow>
        <FeatureRow
          label={t('ConsultanciesPage.row3Label')}
          title={t('ConsultanciesPage.row3Title')}
          body={t('ConsultanciesPage.row3Body')}
          link={{ label: t('ConsultanciesPage.row3Link'), href: '/features/insights' }}
          visual={<SteeringHealthScene />}
        >
          <Checklist
            items={[
              t('ConsultanciesPage.row3Check1'),
              t('ConsultanciesPage.row3Check2'),
              t('ConsultanciesPage.row3Check3'),
            ]}
          />
        </FeatureRow>
      </WebSection>

      {/* 6 · Security callout */}
      <WebSection spacing="flush" className="tm-consult-secure-section">
        <div className="tm-consult-secure">
          <div className="tm-consult-secure__text">
            <Eyebrow tone="ink">{t('ConsultanciesPage.secureEyebrow')}</Eyebrow>
            <h2 className="tm-consult-secure__title">{t('ConsultanciesPage.secureTitle')}</h2>
            <p className="tm-consult-secure__lede">{t('ConsultanciesPage.secureLede')}</p>
            <ButtonLink href="/security" tone="lime">
              {t('ConsultanciesPage.secureButton')}
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
      <WebSection tone="sunken" aria-label={t('ConsultanciesPage.storyLabel')}>
        <figure className="tm-consult-story-card">
          <div className="tm-consult-story-card__quote">
            <Badge>{t('ConsultanciesPage.storyBadge')}</Badge>
            <blockquote className="tm-consult-story-card__text">
              <p>{t('ConsultanciesPage.storyQuote')}</p>
            </blockquote>
            <figcaption className="tm-consult-story-card__by">
              <Avatar name="Partner name" audience="client" decorative />
              <span>
                <span className="tm-consult-story-card__name">
                  {t('ConsultanciesPage.storyName')}
                </span>
                <span className="tm-consult-story-card__org">
                  {t('ConsultanciesPage.storyOrg')}
                </span>
              </span>
            </figcaption>
          </div>
          <dl className="tm-consult-story-card__facts">
            {STORY_MEASURES.map((item) => (
              <div key={item.label}>
                <dt>
                  <IconOrb icon={item.icon} tone="lime" />
                  <span className="tm-visually-hidden">{t('ConsultanciesPage.measurePrefix')}</span>
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
      <CtaBand title={t('ConsultanciesPage.ctaTitle')} lede={t('ConsultanciesPage.ctaLede')} />
    </div>
  );
}
