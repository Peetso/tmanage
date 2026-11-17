'use client';

import type { ReactNode } from 'react';
import Link from '../../WebLink';
import { Avatar, Badge, StateCapsule, type CapsuleState } from '@tmanage/ui';
import { ButtonLink, CtaBand, SectionHeader, Stat, WebIcon, WebSection } from '../../index';
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
import type { MessageKey } from '../../../../lib/i18n/t';
import { CompareLinks } from '../alternatives/CompareLinks';

/**
 * Solutions · Agencies & studios (WEB-08), built to the round-2 Figma frame 308:33: hero with the
 * portfolio, pain → answer cards, the five-step workflow, three alternating rows with product
 * clones, template cards, the design-partner story with its two pending stats, the CTA band.
 */

function Checklist({ items }: { items: readonly string[] }) {
  return (
    <ul className="tm-web-ag-checklist">
      {items.map((item) => (
        <li key={item}>
          <WebIcon name="check" size={16} />
          {item}
        </li>
      ))}
    </ul>
  );
}

/** One feature row: mono label, title, body, checklist and a text link beside its product clone. */
function AgRow({
  label,
  title,
  body,
  checks,
  link,
  visual,
  reverse = false,
}: {
  label: string;
  title: string;
  body: string;
  checks: readonly string[];
  link: { label: string; href: string };
  visual: ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className={cx('tm-web-feature', 'tm-web-ag-row', reverse && 'tm-web-feature--reverse')}>
      <div className="tm-web-feature__text">
        <p className="tm-web-ag-row__label">{label}</p>
        <h3 className="tm-web-ag-row__title">{title}</h3>
        <p className="tm-web-ag-row__body">{body}</p>
        <Checklist items={checks} />
        <Link href={link.href} className="tm-web-ag-textlink">
          {link.label}
        </Link>
      </div>
      <div className="tm-web-ag-row__visual">{visual}</div>
    </div>
  );
}

const PAINS: readonly { pain: MessageKey; answer: MessageKey; body: MessageKey }[] = [
  {
    pain: 'SolutionsAgenciesPage.pain1Pain',
    answer: 'SolutionsAgenciesPage.pain1Answer',
    body: 'SolutionsAgencies.pain1Body',
  },
  {
    pain: 'SolutionsAgenciesPage.pain2Pain',
    answer: 'SolutionsAgenciesPage.pain2Answer',
    body: 'SolutionsAgencies.pain2Body',
  },
  {
    pain: 'SolutionsAgenciesPage.pain3Pain',
    answer: 'SolutionsAgenciesPage.pain3Answer',
    body: 'SolutionsAgencies.pain3Body',
  },
];

const STEPS: readonly {
  title: MessageKey;
  body: MessageKey;
  label: MessageKey;
  state: CapsuleState;
}[] = [
  {
    title: 'SolutionsAgenciesPage.step1Title',
    body: 'SolutionsAgencies.step1Body',
    label: 'SolutionsAgenciesPage.step1Label',
    state: 'done',
  },
  {
    title: 'SolutionsAgenciesPage.step2Title',
    body: 'SolutionsAgencies.step2Body',
    label: 'SolutionsAgenciesPage.step2Label',
    state: 'done',
  },
  {
    title: 'SolutionsAgenciesPage.step3Title',
    body: 'SolutionsAgencies.step3Body',
    label: 'SolutionsAgenciesPage.step3Label',
    state: 'current',
  },
  {
    title: 'SolutionsAgenciesPage.step4Title',
    body: 'SolutionsAgencies.step4Body',
    label: 'SolutionsAgenciesPage.step4Label',
    state: 'client',
  },
  {
    title: 'SolutionsAgenciesPage.step5Title',
    body: 'SolutionsAgencies.step5Body',
    label: 'SolutionsAgencies.step5Label',
    state: 'future',
  },
];

const TEMPLATES: readonly {
  phases: MessageKey;
  title: MessageKey;
  line: MessageKey;
  body: MessageKey;
}[] = [
  {
    phases: 'SolutionsAgencies.template1Phases',
    title: 'SolutionsAgenciesPage.template1Title',
    line: 'SolutionsAgencies.template1Line',
    body: 'SolutionsAgencies.template1Body',
  },
  {
    phases: 'SolutionsAgencies.template2Phases',
    title: 'SolutionsAgenciesPage.template2Title',
    line: 'SolutionsAgencies.template2Line',
    body: 'SolutionsAgencies.template2Body',
  },
  {
    phases: 'SolutionsAgencies.template3Phases',
    title: 'SolutionsAgenciesPage.template3Title',
    line: 'SolutionsAgencies.template3Line',
    body: 'SolutionsAgencies.template3Body',
  },
];

export function SolutionsAgenciesPage() {
  const t = useT();

  return (
    <>
      {/* 2 · Hero */}
      <WebSection spacing="compact" className="tm-web-ag-hero" aria-labelledby="ag-hero-title">
        <div className="tm-web-ag-hero__grid">
          <div className="tm-web-ag-hero__text">
            <Badge className="tm-web-ag-hero__eyebrow">
              {t('SolutionsAgenciesPage.heroEyebrow')}
            </Badge>
            <SectionHeader
              title={t('SolutionsAgenciesPage.heroTitle')}
              lede={t('SolutionsAgenciesPage.heroLede')}
              as="h1"
              size="hero"
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
          <div className="tm-web-ag-hero__visual">
            <PortfolioScene />
          </div>
        </div>
      </WebSection>

      {/* 3 · Pain → answer */}
      <WebSection tone="sunken" aria-labelledby="ag-pain-title">
        <SectionHeader
          align="center"
          eyebrow={t('SolutionsAgencies.painEyebrow')}
          title={t('SolutionsAgencies.painTitle')}
          lede={t('SolutionsAgencies.painLede')}
          id="ag-pain-title"
        />
        <ul className="tm-web-ag-cards">
          {PAINS.map((item) => (
            <li key={item.answer} className="tm-web-ag-card">
              <Badge>{t('SolutionsAgenciesPage.today')}</Badge>
              <p className="tm-web-ag-card__muted">{t(item.pain)}</p>
              <div className="tm-web-ag-answer">
                <p className="tm-web-ag-answer__with">
                  <WebIcon name="check" size={16} />
                  {t('SolutionsAgenciesPage.withTManage')}
                </p>
                <h3 className="tm-web-ag-answer__title">{t(item.answer)}</h3>
                <p className="tm-web-ag-answer__body">{t(item.body)}</p>
              </div>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 4 · Workflow strip */}
      <WebSection aria-labelledby="ag-flow-title">
        <SectionHeader
          align="center"
          eyebrow={t('SolutionsAgencies.flowEyebrow')}
          title={t('SolutionsAgencies.flowTitle')}
          lede={t('SolutionsAgencies.flowLede')}
          id="ag-flow-title"
        />
        <ol className="tm-web-ag-flow">
          {STEPS.map((step, index) => (
            <li key={step.title} className="tm-web-ag-step">
              <span className="tm-web-scene__mono">{String(index + 1).padStart(2, '0')}</span>
              <StateCapsule state={step.state}>{t(step.label)}</StateCapsule>
              <h3 className="tm-web-ag-step__title">{t(step.title)}</h3>
              <p className="tm-web-ag-step__body">{t(step.body)}</p>
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
          label={t('SolutionsAgencies.row1Label')}
          title={t('SolutionsAgenciesPage.row1Title')}
          body={t('SolutionsAgencies.row1Body')}
          checks={[
            t('SolutionsAgencies.row1Check1'),
            t('SolutionsAgencies.row1Check2'),
            t('SolutionsAgencies.row1Check3'),
          ]}
          link={{ label: t('SolutionsAgencies.row1Link'), href: '/client-portal' }}
          visual={<ClientBoundariesScene />}
        />
        <AgRow
          reverse
          label={t('SolutionsAgenciesPage.row2Label')}
          title={t('SolutionsAgenciesPage.row2Title')}
          body={t('SolutionsAgencies.row2Body')}
          checks={[
            t('SolutionsAgencies.row2Check1'),
            t('SolutionsAgencies.row2Check2'),
            t('SolutionsAgencies.row2Check3'),
          ]}
          link={{ label: t('SolutionsAgencies.row2Link'), href: '/features/knowledge' }}
          visual={<CreativeReviewScene />}
        />
        <AgRow
          label={t('SolutionsAgenciesPage.row3Label')}
          title={t('SolutionsAgenciesPage.row3Title')}
          body={t('SolutionsAgencies.row3Body')}
          checks={[
            t('SolutionsAgencies.row3Check1'),
            t('SolutionsAgencies.row3Check2'),
            t('SolutionsAgencies.row3Check3'),
          ]}
          link={{ label: t('SolutionsAgencies.row3Link'), href: '/features/work' }}
          visual={<RetainerPlanScene />}
        />
      </WebSection>

      {/* 6 · Templates + 7 · Story, on one paper/150 band */}
      <WebSection tone="sunken" aria-labelledby="ag-templates-title" className="tm-web-ag-band">
        <SectionHeader
          align="center"
          eyebrow={t('SolutionsAgencies.templatesEyebrow')}
          title={t('SolutionsAgencies.templatesTitle')}
          lede={t('SolutionsAgencies.templatesLede')}
          id="ag-templates-title"
        />
        <ul className="tm-web-ag-cards">
          {TEMPLATES.map((template) => (
            <li key={template.title} className="tm-web-ag-card">
              <Badge>{t(template.phases)}</Badge>
              <h3 className="tm-web-ag-card__muted">{t(template.title)}</h3>
              <div className="tm-web-ag-answer">
                <p className="tm-web-ag-answer__with">
                  <WebIcon name="check" size={16} />
                  {t('SolutionsAgencies.templateBadge')}
                </p>
                <p className="tm-web-ag-answer__title">{t(template.line)}</p>
                <p className="tm-web-ag-answer__body">{t(template.body)}</p>
              </div>
              <Link href={SIGN_UP_HREF} className="tm-web-ag-textlink">
                {t('SolutionsAgenciesPage.useTemplate')}
              </Link>
            </li>
          ))}
        </ul>

        <figure className="tm-web-ag-story" aria-label={t('SolutionsAgenciesPage.storyLabel')}>
          <div className="tm-web-ag-story__quote">
            <Badge>{t('SolutionsAgenciesPage.storyBadge')}</Badge>
            <blockquote className="tm-web-ag-story__text">
              <p>“{t('SolutionsAgenciesPage.storyQuote')}”</p>
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
          <div
            className="tm-web-ag-story__stats"
            role="group"
            aria-label={t('SolutionsAgenciesPage.storyFactsLabel')}
          >
            <Stat
              value="—"
              label={t('SolutionsAgencies.stat1Label')}
              note={t('SolutionsAgencies.stat1Note')}
            />
            <Stat
              value="—"
              label={t('SolutionsAgencies.stat2Label')}
              note={t('SolutionsAgencies.stat2Note')}
            />
          </div>
        </figure>
      </WebSection>

      {/* 8 · CTA band */}
      <CompareLinks topic="solutions-agencies" />

      <CtaBand title={t('SolutionsAgencies.ctaTitle')} lede={t('SolutionsAgencies.ctaLede')} />
    </>
  );
}
