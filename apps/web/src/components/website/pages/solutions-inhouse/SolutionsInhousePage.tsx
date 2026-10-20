'use client';

import type { ReactNode } from 'react';
import { Avatar, Badge, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { ArrowLink, ButtonLink, cx } from '../../primitives';
import { SectionHeader, WebSection } from '../../sections';
import { WebIcon } from '../../WebIcon';
import {
  IntakeFormScene,
  RequestInboxScene,
  StakeholderReviewScene,
  WorkloadScene,
} from './scenes';
import './solutions-inhouse.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { useT } from '../../../../lib/i18n/use-t';

/**
 * Solutions · In-house teams — `/solutions/in-house`, built to the approved design
 * (shots/10-solutions-inhouse.png) and SITE-SPEC. Sections: hero, pain → answer, workflow,
 * three alternating rows, story card, CTA band. Nav and footer come from the route group.
 */

function Checklist({ items }: { items: readonly string[] }) {
  return (
    <ul className="tm-inh-checks">
      {items.map((item) => (
        <li key={item}>
          <WebIcon name="check" size={14} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({
  kicker,
  title,
  body,
  checks,
  link,
  visual,
  reverse = false,
}: {
  kicker: string;
  title: string;
  body: string;
  checks: readonly string[];
  link: { label: string; href: string };
  visual: ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className={cx('tm-inh-row', reverse && 'tm-inh-row--reverse')}>
      <div className="tm-inh-row__text">
        <p className="tm-web-eyebrow tm-inh-kicker">{kicker}</p>
        <h3 className="tm-web-feature__title">{title}</h3>
        <p className="tm-web-feature__body">{body}</p>
        <Checklist items={checks} />
        <ArrowLink href={link.href} underline={false}>
          {link.label}
        </ArrowLink>
      </div>
      <div className="tm-inh-row__visual">{visual}</div>
    </div>
  );
}

export function SolutionsInhousePage() {
  const t = useT();

  const PAINS = [
    {
      today: t('SolutionsInhousePage.pain1Today'),
      answer: t('SolutionsInhousePage.pain1Answer'),
      body: t('SolutionsInhousePage.pain1Body'),
    },
    {
      today: t('SolutionsInhousePage.pain2Today'),
      answer: t('SolutionsInhousePage.pain2Answer'),
      body: t('SolutionsInhousePage.pain2Body'),
    },
    {
      today: t('SolutionsInhousePage.pain3Today'),
      answer: t('SolutionsInhousePage.pain3Answer'),
      body: t('SolutionsInhousePage.pain3Body'),
    },
  ] as const;

  const STEPS: readonly {
    title: string;
    body: string;
    state: CapsuleState;
    label: string;
  }[] = [
    {
      title: t('SolutionsInhousePage.step1Title'),
      body: t('SolutionsInhousePage.step1Body'),
      state: 'done',
      label: t('SolutionsInhousePage.step1Label'),
    },
    {
      title: t('SolutionsInhousePage.step2Title'),
      body: t('SolutionsInhousePage.step2Body'),
      state: 'done',
      label: t('SolutionsInhousePage.step2Label'),
    },
    {
      title: t('SolutionsInhousePage.step3Title'),
      body: t('SolutionsInhousePage.step3Body'),
      state: 'current',
      label: t('SolutionsInhousePage.step3Label'),
    },
    {
      title: t('SolutionsInhousePage.step4Title'),
      body: t('SolutionsInhousePage.step4Body'),
      state: 'future',
      label: t('SolutionsInhousePage.step4Label'),
    },
    {
      title: t('SolutionsInhousePage.step5Title'),
      body: t('SolutionsInhousePage.step5Body'),
      state: 'client',
      label: t('SolutionsInhousePage.step5Label'),
    },
  ];

  return (
    <div className="tm-inh">
      {/* Hero */}
      <WebSection tone="surface" className="tm-inh-hero" aria-labelledby="inh-hero-title">
        <div className="tm-inh-hero__grid">
          <div className="tm-inh-hero__text">
            <Badge className="tm-inh-eyebrow">{t('SolutionsInhousePage.heroEyebrow')}</Badge>
            <h1 id="inh-hero-title" className="tm-metric__value tm-inh-hero__title">
              {t('SolutionsInhousePage.heroTitle')}
            </h1>
            <p className="tm-inh-hero__lede">{t('SolutionsInhousePage.heroLede')}</p>
            <div className="tm-inh-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('SolutionsInhousePage.startFree')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                {t('SolutionsInhousePage.bookDemo')}
              </ButtonLink>
            </div>
          </div>
          <div className="tm-inh-hero__visual">
            <RequestInboxScene />
          </div>
        </div>
      </WebSection>

      {/* Pain → answer */}
      <WebSection tone="sunken" aria-labelledby="inh-pain-title">
        <SectionHeader
          id="inh-pain-title"
          align="center"
          eyebrow={t('SolutionsInhousePage.painEyebrow')}
          title={t('SolutionsInhousePage.painTitle')}
          lede={t('SolutionsInhousePage.painLede')}
        />
        <ul className="tm-inh-pains">
          {PAINS.map((pain) => (
            <li key={pain.today} className="tm-inh-pain">
              <Badge>{t('SolutionsInhousePage.today')}</Badge>
              <p className="tm-inh-pain__today">{pain.today}</p>
              <div className="tm-inh-pain__answer">
                <p className="tm-metric__label tm-inh-pain__with">
                  <WebIcon name="check" size={14} />
                  {t('SolutionsInhousePage.withTManage')}
                </p>
                <p className="tm-inline-alert__title tm-inh-pain__title">{pain.answer}</p>
                <p className="tm-inh-pain__body">{pain.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* Workflow */}
      <WebSection aria-labelledby="inh-flow-title">
        <SectionHeader
          id="inh-flow-title"
          align="center"
          eyebrow={t('SolutionsInhousePage.flowEyebrow')}
          title={t('SolutionsInhousePage.flowTitle')}
          lede={t('SolutionsInhousePage.flowLede')}
        />
        <ol className="tm-inh-steps">
          {STEPS.map((step, index) => (
            <li key={step.title} className="tm-inh-step">
              <span className="tm-inh-mono">{String(index + 1).padStart(2, '0')}</span>
              <StateCapsule state={step.state}>{step.label}</StateCapsule>
              <p className="tm-card__title tm-inh-step__title">{step.title}</p>
              <p className="tm-inh-step__body">{step.body}</p>
              {index < STEPS.length - 1 ? (
                <span className="tm-inh-step__arrow" aria-hidden="true">
                  <WebIcon name="arrow-right" size={14} />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </WebSection>

      {/* Alternating rows */}
      <WebSection aria-label={t('SolutionsInhousePage.rowsLabel')} className="tm-inh-rows">
        <Row
          kicker={t('SolutionsInhousePage.row1Kicker')}
          title={t('SolutionsInhousePage.row1Title')}
          body={t('SolutionsInhousePage.row1Body')}
          checks={[
            t('SolutionsInhousePage.row1Check1'),
            t('SolutionsInhousePage.row1Check2'),
            t('SolutionsInhousePage.row1Check3'),
          ]}
          link={{ label: t('SolutionsInhousePage.row1Link'), href: '/features/work' }}
          visual={<IntakeFormScene />}
        />
        <Row
          reverse
          kicker={t('SolutionsInhousePage.row2Kicker')}
          title={t('SolutionsInhousePage.row2Title')}
          body={t('SolutionsInhousePage.row2Body')}
          checks={[
            t('SolutionsInhousePage.row2Check1'),
            t('SolutionsInhousePage.row2Check2'),
            t('SolutionsInhousePage.row2Check3'),
          ]}
          link={{ label: t('SolutionsInhousePage.row2Link'), href: '/features/knowledge' }}
          visual={<StakeholderReviewScene />}
        />
        <Row
          kicker={t('SolutionsInhousePage.row3Kicker')}
          title={t('SolutionsInhousePage.row3Title')}
          body={t('SolutionsInhousePage.row3Body')}
          checks={[
            t('SolutionsInhousePage.row3Check1'),
            t('SolutionsInhousePage.row3Check2'),
            t('SolutionsInhousePage.row3Check3'),
          ]}
          link={{ label: t('SolutionsInhousePage.row3Link'), href: '/features/insights' }}
          visual={<WorkloadScene />}
        />
      </WebSection>

      {/* Story card */}
      <WebSection tone="sunken" aria-label={t('SolutionsInhousePage.storyLabel')}>
        <figure className="tm-inh-story">
          <div className="tm-inh-story__main">
            <Badge>{t('SolutionsInhousePage.storyBadge')}</Badge>
            <blockquote className="tm-web-feature__title tm-inh-story__quote">
              <p>{t('SolutionsInhousePage.storyQuote')}</p>
            </blockquote>
            <figcaption className="tm-inh-story__by">
              <Avatar name="H O" audience="client" decorative className="tm-inh-story__avatar" />
              <span className="tm-inh-story__who">
                <span className="tm-metric__label tm-inh-story__name">
                  {t('SolutionsInhousePage.storyName')}
                </span>
                <span className="tm-inh-story__org">{t('SolutionsInhousePage.storyOrg')}</span>
              </span>
            </figcaption>
          </div>
          <dl className="tm-inh-story__facts">
            <div className="tm-inh-story__fact">
              <dt>
                <span className="tm-inh-story__bar" aria-hidden="true" />
                <span className="tm-visually-hidden">{t('SolutionsInhousePage.figureToCome')}</span>
                {t('SolutionsInhousePage.fact1Text')}
              </dt>
              <dd>{t('SolutionsInhousePage.fact1Note')}</dd>
            </div>
            <div className="tm-inh-story__fact">
              <dt>
                <span className="tm-inh-story__bar" aria-hidden="true" />
                <span className="tm-visually-hidden">{t('SolutionsInhousePage.figureToCome')}</span>
                {t('SolutionsInhousePage.fact2Text')}
              </dt>
              <dd>{t('SolutionsInhousePage.fact2Note')}</dd>
            </div>
          </dl>
        </figure>
      </WebSection>

      {/* CTA band */}
      <section className="tm-web-cta-section tm-inh-cta" aria-labelledby="inh-cta-title">
        <div className="tm-web-container">
          <div className="tm-web-cta tm-web-cta--text">
            <div className="tm-web-cta__text">
              <h2 id="inh-cta-title" className="tm-web-cta__title">
                {t('SolutionsInhousePage.ctaTitle')}
              </h2>
              <p className="tm-web-cta__lede">{t('SolutionsInhousePage.ctaLede')}</p>
              <div className="tm-web-cta__actions">
                <ButtonLink href={SIGN_UP_HREF} tone="lime">
                  {t('SolutionsInhousePage.startFree')}
                </ButtonLink>
                <ButtonLink href="/contact" tone="outline-ink">
                  {t('SolutionsInhousePage.bookDemo')}
                </ButtonLink>
              </div>
              <p className="tm-web-cta__note">{t('SolutionsInhousePage.ctaNote')}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
