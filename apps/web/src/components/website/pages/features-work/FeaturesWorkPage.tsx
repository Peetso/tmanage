'use client';

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Badge, Button, StatusDot, type StatusTone } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import {
  ButtonLink,
  CtaBand,
  Eyebrow,
  FaqRow,
  FeatureRow,
  SectionHeader,
  StatBand,
  WebSection,
  type StatProps,
} from '../../index';
import {
  BoardViewScene,
  ListViewScene,
  ProjectPulseScene,
  RequestScene,
  TemplatePreview,
  TimelineViewScene,
  WorkBoardScene,
  WorkItemScene,
  type PhaseTone,
} from './scenes';
import './features-work.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * Features · Work, requests & projects (`/features/work`, Figma 03-features-work, SITE-SPEC
 * "PAGE: Features · Work, requests & projects"). Hero with the Work board, Requests, Work items,
 * Views, Projects & portfolio (ink panel), product-fact stats, Templates, FAQ and the CTA band.
 * Every product visual is a mini scene from `./scenes`, composed from packages/ui parts.
 */

const ANCHORS: readonly { labelKey: MessageKey; href: string }[] = [
  { labelKey: 'FeaturesWorkPage.anchorRequests', href: '#requests' },
  { labelKey: 'FeaturesWorkPage.anchorWorkItems', href: '#work-items' },
  { labelKey: 'FeaturesWorkPage.anchorViews', href: '#views' },
  { labelKey: 'FeaturesWorkPage.anchorProjects', href: '#projects' },
  { labelKey: 'FeaturesWorkPage.anchorTemplates', href: '#templates' },
];

const VIEWS: readonly {
  key: string;
  labelKey: MessageKey;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  scene: ReactNode;
}[] = [
  {
    key: 'list',
    labelKey: 'FeaturesWorkPage.viewListLabel',
    titleKey: 'FeaturesWorkPage.viewListTitle',
    bodyKey: 'FeaturesWorkPage.viewListBody',
    scene: <ListViewScene />,
  },
  {
    key: 'board',
    labelKey: 'FeaturesWorkPage.viewBoardLabel',
    titleKey: 'FeaturesWorkPage.viewBoardTitle',
    bodyKey: 'FeaturesWorkPage.viewBoardBody',
    scene: <BoardViewScene />,
  },
  {
    key: 'timeline',
    labelKey: 'FeaturesWorkPage.viewTimelineLabel',
    titleKey: 'FeaturesWorkPage.viewTimelineTitle',
    bodyKey: 'FeaturesWorkPage.viewTimelineBody',
    scene: <TimelineViewScene />,
  },
];

const PULSE_POINTS: readonly { tone: StatusTone; termKey: MessageKey; detailKey: MessageKey }[] = [
  {
    tone: 'live',
    termKey: 'FeaturesWorkPage.pulseForecastTerm',
    detailKey: 'FeaturesWorkPage.pulseForecastDetail',
  },
  {
    tone: 'success',
    termKey: 'FeaturesWorkPage.pulseCommitmentTerm',
    detailKey: 'FeaturesWorkPage.pulseCommitmentDetail',
  },
  {
    tone: 'warning',
    termKey: 'FeaturesWorkPage.pulseRiskTerm',
    detailKey: 'FeaturesWorkPage.pulseRiskDetail',
  },
  {
    tone: 'neutral',
    termKey: 'FeaturesWorkPage.pulseFreshnessTerm',
    detailKey: 'FeaturesWorkPage.pulseFreshnessDetail',
  },
];

const WORK_ITEM_FIELDS: readonly MessageKey[] = [
  'FeaturesWorkPage.fieldOwner',
  'FeaturesWorkPage.fieldCollaborators',
  'FeaturesWorkPage.fieldDependencies',
  'FeaturesWorkPage.fieldChecklist',
  'FeaturesWorkPage.fieldAudience',
];

/** "See it in a demo" (SITE-SPEC) — the demo request form on the contact page. */
const DEMO_HREF = '/contact#book-demo-form';

type TemplateStep = { title: string; when: string; tone: PhaseTone };

interface TemplateData {
  title: string;
  meta: string;
  length: string;
  phases: readonly PhaseTone[];
  /** The three steps the closed card shows. */
  steps: readonly TemplateStep[];
  /** The whole plan, one step per phase, shown when the card is previewed. */
  plan: readonly TemplateStep[];
}

const TEMPLATES: readonly TemplateData[] = [
  {
    title: 'Website relaunch',
    meta: '6 milestones · 38 work items · 2 client reviews',
    length: '8 weeks',
    phases: ['internal', 'internal', 'client', 'internal', 'client', 'launch'],
    steps: [
      { title: 'Discovery and sitemap', when: 'WK 1–2', tone: 'internal' },
      { title: 'Homepage direction review', when: 'WK 3', tone: 'client' },
      { title: 'Launch and handover', when: 'WK 8', tone: 'launch' },
    ],
    plan: [
      { title: 'Discovery and sitemap', when: 'WK 1–2', tone: 'internal' },
      { title: 'Content audit and wireframes', when: 'WK 2–3', tone: 'internal' },
      { title: 'Homepage direction review', when: 'WK 3', tone: 'client' },
      { title: 'Templates and content build', when: 'WK 4–6', tone: 'internal' },
      { title: 'Staging review with client', when: 'WK 7', tone: 'client' },
      { title: 'Launch and handover', when: 'WK 8', tone: 'launch' },
    ],
  },
  {
    title: 'Brand identity sprint',
    meta: '4 milestones · 22 work items · 3 concept rounds',
    length: '5 weeks',
    phases: ['internal', 'client', 'client', 'internal', 'launch'],
    steps: [
      { title: 'Brief and brand audit', when: 'WK 1', tone: 'internal' },
      { title: 'Concept round with client', when: 'WK 2–3', tone: 'client' },
      { title: 'Final identity kit', when: 'WK 5', tone: 'launch' },
    ],
    plan: [
      { title: 'Brief and brand audit', when: 'WK 1', tone: 'internal' },
      { title: 'Concept round with client', when: 'WK 2', tone: 'client' },
      { title: 'Refined direction review', when: 'WK 3', tone: 'client' },
      { title: 'Guidelines and asset build', when: 'WK 4', tone: 'internal' },
      { title: 'Final identity kit', when: 'WK 5', tone: 'launch' },
    ],
  },
  {
    title: 'Monthly retainer',
    meta: 'Recurs monthly · request intake · Pulse update',
    length: 'Monthly',
    phases: ['internal', 'internal', 'client', 'launch'],
    steps: [
      { title: 'Request intake and triage', when: 'WK 1', tone: 'internal' },
      { title: 'Deliverables in review', when: 'WK 2–3', tone: 'client' },
      { title: 'Pulse update to client', when: 'WK 4', tone: 'launch' },
    ],
    plan: [
      { title: 'Request intake and triage', when: 'WK 1', tone: 'internal' },
      { title: 'Planned work in progress', when: 'WK 1–3', tone: 'internal' },
      { title: 'Deliverables in review', when: 'WK 2–3', tone: 'client' },
      { title: 'Pulse update to client', when: 'WK 4', tone: 'launch' },
    ],
  },
];

const FAQS: readonly { questionKey: MessageKey; answerKey: MessageKey }[] = [
  {
    questionKey: 'FeaturesWorkPage.faqClientsQ',
    answerKey: 'FeaturesWorkPage.faqClientsA',
  },
  {
    questionKey: 'FeaturesWorkPage.faqMultiProjectQ',
    answerKey: 'FeaturesWorkPage.faqMultiProjectA',
  },
  {
    questionKey: 'FeaturesWorkPage.faqRecurringQ',
    answerKey: 'FeaturesWorkPage.faqRecurringA',
  },
  {
    questionKey: 'FeaturesWorkPage.faqImportQ',
    answerKey: 'FeaturesWorkPage.faqImportA',
  },
];

/**
 * A template card. "Preview" opens the whole plan in place — every phase with its week — and
 * "Use template" starts from it, which needs a signed-in workspace.
 */
function TemplateCard({ tpl }: { tpl: TemplateData }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const previewId = useId();
  const shown = open ? tpl.plan : tpl.steps;
  return (
    <li className="tm-fw-template">
      <div id={previewId}>
        <TemplatePreview
          label={`${tpl.title} template: ${shown.map((s) => `${s.title}, ${s.when}`).join('; ')}.`}
          phases={tpl.phases}
          steps={shown}
        />
      </div>
      <h3 className="tm-fw-template__title">{tpl.title}</h3>
      <p className="tm-fw-template__meta">{tpl.meta}</p>
      <div className="tm-fw-template__foot">
        <Badge>{tpl.length}</Badge>
        <span className="tm-fw-template__actions">
          <Button
            tone="outline"
            size="default"
            className="tm-web-button"
            aria-expanded={open}
            aria-controls={previewId}
            onClick={() => setOpen((value) => !value)}
          >
            {open
              ? t('FeaturesWorkPage.templateClosePreview')
              : t('FeaturesWorkPage.templatePreview')}
          </Button>
          <ButtonLink href={SIGN_UP_HREF} tone="ink" size="default">
            {t('FeaturesWorkPage.templateUse')}
          </ButtonLink>
        </span>
      </div>
    </li>
  );
}

export function FeaturesWorkPage() {
  const t = useT();
  const workStats: readonly StatProps[] = [
    {
      value: '3',
      unit: t('FeaturesWorkPage.statViewsUnit'),
      label: t('FeaturesWorkPage.statViewsLabel'),
      note: t('FeaturesWorkPage.statViewsNote'),
    },
    {
      value: '1',
      unit: t('FeaturesWorkPage.statOwnerUnit'),
      label: t('FeaturesWorkPage.statOwnerLabel'),
      note: t('FeaturesWorkPage.statOwnerNote'),
    },
    {
      value: '0',
      unit: t('FeaturesWorkPage.statPromisesUnit'),
      label: t('FeaturesWorkPage.statPromisesLabel'),
      note: t('FeaturesWorkPage.statPromisesNote'),
    },
    {
      value: '2',
      unit: t('FeaturesWorkPage.statLanguagesUnit'),
      label: t('FeaturesWorkPage.statLanguagesLabel'),
      note: t('FeaturesWorkPage.statLanguagesNote'),
    },
  ];
  return (
    <div className="tm-fw">
      {/* 2 · Hero */}
      <WebSection className="tm-fw-hero" aria-labelledby="fw-hero-title">
        <div className="tm-fw-hero__grid">
          <div className="tm-fw-hero__copy">
            <SectionHeader
              as="h1"
              size="page"
              id="fw-hero-title"
              eyebrow={t('FeaturesWorkPage.heroEyebrow')}
              title={t('FeaturesWorkPage.heroTitle')}
              lede={t('FeaturesWorkPage.heroLede')}
            />
            <div className="tm-fw-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('FeaturesWorkPage.startFree')}
              </ButtonLink>
              <ButtonLink href={DEMO_HREF} tone="outline">
                {t('FeaturesWorkPage.seeDemo')}
              </ButtonLink>
            </div>
            <nav className="tm-fw-anchors" aria-label={t('FeaturesWorkPage.anchorsAria')}>
              {ANCHORS.map((anchor) => (
                <Link key={anchor.href} href={anchor.href} className="tm-web-chip tm-fw-anchor">
                  {t(anchor.labelKey)}
                </Link>
              ))}
            </nav>
          </div>
          <div className="tm-fw-hero__visual">
            <WorkBoardScene />
          </div>
        </div>
      </WebSection>

      {/* 3 · Requests · 4 · Work items */}
      <WebSection className="tm-fw-rows" aria-labelledby="requests-title">
        <FeatureRow
          id="requests"
          label={t('FeaturesWorkPage.requestsLabel')}
          title={<span id="requests-title">{t('FeaturesWorkPage.requestsTitle')}</span>}
          body={t('FeaturesWorkPage.requestsBody')}
          visual={<RequestScene />}
        />
        <FeatureRow
          id="work-items"
          label={t('FeaturesWorkPage.workItemsLabel')}
          reverse
          title={t('FeaturesWorkPage.workItemsTitle')}
          body={t('FeaturesWorkPage.workItemsBody')}
          visual={<WorkItemScene />}
        >
          <ul className="tm-fw-chips" aria-label={t('FeaturesWorkPage.fieldsAria')}>
            {WORK_ITEM_FIELDS.map((fieldKey) => (
              <li key={fieldKey} className="tm-web-chip">
                {t(fieldKey)}
              </li>
            ))}
          </ul>
        </FeatureRow>
      </WebSection>

      {/* 5 · Views */}
      <WebSection tone="sunken" id="views" aria-labelledby="views-title">
        <SectionHeader
          align="center"
          id="views-title"
          eyebrow={t('FeaturesWorkPage.viewsEyebrow')}
          title={t('FeaturesWorkPage.viewsTitle')}
          lede={t('FeaturesWorkPage.viewsLede')}
        />
        <ul className="tm-fw-views">
          {VIEWS.map((view) => (
            <li key={view.key} className="tm-fw-view">
              <div className="tm-fw-view__visual">{view.scene}</div>
              <p className="tm-web-eyebrow tm-fw-view__label">{t(view.labelKey)}</p>
              <h3 className="tm-fw-view__title">{t(view.titleKey)}</h3>
              <p className="tm-fw-view__body">{t(view.bodyKey)}</p>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 6 · Projects & portfolio */}
      <WebSection id="projects" className="tm-fw-projects" aria-labelledby="projects-title">
        <div className="tm-fw-ink">
          <div className="tm-fw-ink__copy">
            <Eyebrow tone="ink">{t('FeaturesWorkPage.projectsEyebrow')}</Eyebrow>
            <h2 id="projects-title" className="tm-web-header__title tm-fw-ink__title">
              {t('FeaturesWorkPage.projectsTitle')}
            </h2>
            <p className="tm-fw-ink__body">{t('FeaturesWorkPage.projectsBody')}</p>
            <ul className="tm-fw-ink__points">
              {PULSE_POINTS.map((point) => (
                <li key={point.termKey}>
                  <StatusDot tone={point.tone}>
                    {t(point.termKey)} — {t(point.detailKey)}
                  </StatusDot>
                </li>
              ))}
            </ul>
          </div>
          <div className="tm-fw-ink__visual">
            <ProjectPulseScene />
          </div>
        </div>
      </WebSection>

      {/* Product facts */}
      <WebSection
        spacing="compact"
        className="tm-fw-facts-band"
        aria-label={t('FeaturesWorkPage.factsAria')}
      >
        <StatBand stats={workStats} />
      </WebSection>

      {/* 7 · Templates */}
      <WebSection id="templates" className="tm-fw-templates-band" aria-labelledby="templates-title">
        <SectionHeader
          id="templates-title"
          eyebrow={t('FeaturesWorkPage.templatesEyebrow')}
          title={t('FeaturesWorkPage.templatesTitle')}
          lede={t('FeaturesWorkPage.templatesLede')}
        />
        <ul className="tm-fw-templates">
          {TEMPLATES.map((tpl) => (
            <TemplateCard key={tpl.title} tpl={tpl} />
          ))}
        </ul>
      </WebSection>

      {/* 8 · FAQ */}
      <WebSection aria-labelledby="fw-faq-title" className="tm-fw-faq">
        <SectionHeader
          align="center"
          id="fw-faq-title"
          eyebrow={t('FeaturesWorkPage.faqEyebrow')}
          title={t('FeaturesWorkPage.faqTitle')}
          lede={t('FeaturesWorkPage.faqLede')}
        />
        <div className="tm-web-faq-list tm-fw-faq__list">
          {FAQS.map((item, index) => (
            <FaqRow
              key={item.questionKey}
              question={t(item.questionKey)}
              answer={t(item.answerKey)}
              defaultOpen={index === 0}
            />
          ))}
        </div>
      </WebSection>

      {/* 9 · CTA band (footer comes from the website chrome) */}
      <CtaBand
        title={t('FeaturesWorkPage.ctaTitle')}
        lede={t('FeaturesWorkPage.ctaLede')}
        note={t('FeaturesWorkPage.ctaNote')}
        secondary={{ label: t('FeaturesWorkPage.ctaSecondary'), href: DEMO_HREF }}
      />
    </div>
  );
}
