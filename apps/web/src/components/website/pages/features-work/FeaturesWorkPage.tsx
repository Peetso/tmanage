'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, StatusDot, type StatusTone } from '@tmanage/ui';
import {
  ButtonLink,
  CtaBand,
  Eyebrow,
  FaqRow,
  FeatureRow,
  SectionHeader,
  StatBand,
  WebSection,
  type FaqItem,
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

const ANCHORS = [
  { label: 'Requests', href: '#requests' },
  { label: 'Work items', href: '#work-items' },
  { label: 'Views', href: '#views' },
  { label: 'Projects', href: '#projects' },
  { label: 'Templates', href: '#templates' },
] as const;

const VIEWS = [
  {
    key: 'list',
    label: 'List',
    title: '200 rows, keyboard-fast.',
    body: 'Sort, filter and edit in place. Every action has a shortcut.',
    scene: <ListViewScene />,
  },
  {
    key: 'board',
    label: 'Board',
    title: 'Drag, or move without a mouse.',
    body: 'Move cards with the keyboard; blocked moves explain why.',
    scene: <BoardViewScene />,
  },
  {
    key: 'timeline',
    label: 'Timeline',
    title: 'Dependencies you can see.',
    body: 'Bars, links and the critical path, against committed dates.',
    scene: <TimelineViewScene />,
  },
] as const;

const PULSE_POINTS: readonly { tone: StatusTone; term: string; detail: string }[] = [
  { tone: 'live', term: 'Forecast', detail: 'when it will really land' },
  { tone: 'success', term: 'Commitment', detail: 'the date you promised' },
  { tone: 'warning', term: 'Risk', detail: 'what could move it' },
  { tone: 'neutral', term: 'Freshness', detail: 'how recent the evidence is' },
];

const WORK_STATS: readonly StatProps[] = [
  {
    value: '3',
    unit: 'views',
    label: 'list, board and timeline',
    note: 'Every view reads the same items, so nothing is copied.',
  },
  {
    value: '1',
    unit: 'owner',
    label: 'per work item, always',
    note: 'Collaborators help; one person answers for the date.',
  },
  {
    value: '0',
    unit: 'promises',
    label: 'before a manager accepts',
    note: 'A request stays a request until someone owns it.',
  },
  {
    value: '2',
    unit: 'languages',
    label: 'English and Arabic, right-to-left ready',
    note: 'One product, mirrored properly — not translated later.',
  },
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

const FAQS: readonly FaqItem[] = [
  {
    question: 'Can clients see our tasks?',
    answer: 'Only what you publish to them. Tasks are internal by default.',
  },
  {
    question: 'Can one task belong to several projects?',
    answer: 'No. One home project keeps permissions predictable; link related work instead.',
  },
  {
    question: 'Do you support recurring work?',
    answer: 'Yes, through templates and automations.',
  },
  {
    question: 'Can we import from spreadsheets?',
    answer: 'Yes, CSV import maps columns to fields before anything is created.',
  },
];

/**
 * A template card. "Preview" opens the whole plan in place — every phase with its week — and
 * "Use template" starts from it, which needs a signed-in workspace.
 */
function TemplateCard({ tpl }: { tpl: TemplateData }) {
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
            {open ? 'Close preview' : 'Preview'}
          </Button>
          <ButtonLink href={SIGN_UP_HREF} tone="ink" size="default">
            Use template
          </ButtonLink>
        </span>
      </div>
    </li>
  );
}

export function FeaturesWorkPage() {
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
              eyebrow="Features · Plan & deliver"
              title="Every ask becomes owned, dated, visible work."
              lede="Requests, tasks, milestones and projects in one model — viewed as a list, a board or a timeline without losing a thing."
            />
            <div className="tm-fw-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href={DEMO_HREF} tone="outline">
                See it in a demo
              </ButtonLink>
            </div>
            <nav className="tm-fw-anchors" aria-label="On this page">
              {ANCHORS.map((anchor) => (
                <Link key={anchor.href} href={anchor.href} className="tm-web-chip tm-fw-anchor">
                  {anchor.label}
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
          label="Requests"
          title={<span id="requests-title">Client requests with a real intake.</span>}
          body="Title, reason, desired date and files. Nothing is promised until a manager accepts, defers or declines — with a reason the client can read."
          visual={<RequestScene />}
        />
        <FeatureRow
          id="work-items"
          label="Work items"
          reverse
          title="One work item, every detail."
          body="Owner, collaborators, status, priority, dependencies, checklist, files and audience. Required fields appear only when a status needs them."
          visual={<WorkItemScene />}
        >
          <ul className="tm-fw-chips" aria-label="Work item fields">
            {['Owner', 'Collaborators', 'Dependencies', 'Checklist', 'Audience'].map((field) => (
              <li key={field} className="tm-web-chip">
                {field}
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
          eyebrow="Views"
          title="One set of work. Three ways to see it."
          lede="Switch between a list, a board and a timeline. Every view reads the same items, so nothing is copied or out of sync."
        />
        <ul className="tm-fw-views">
          {VIEWS.map((view) => (
            <li key={view.key} className="tm-fw-view">
              <div className="tm-fw-view__visual">{view.scene}</div>
              <p className="tm-web-eyebrow tm-fw-view__label">{view.label}</p>
              <h3 className="tm-fw-view__title">{view.title}</h3>
              <p className="tm-fw-view__body">{view.body}</p>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 6 · Projects & portfolio */}
      <WebSection id="projects" className="tm-fw-projects" aria-labelledby="projects-title">
        <div className="tm-fw-ink">
          <div className="tm-fw-ink__copy">
            <Eyebrow tone="ink">Projects & portfolio</Eyebrow>
            <h2 id="projects-title" className="tm-web-header__title tm-fw-ink__title">
              Milestones move on evidence, not percentages.
            </h2>
            <p className="tm-fw-ink__body">
              Project Pulse shows forecast, commitment, risk and freshness. Portfolio shows the
              exceptions, not every task.
            </p>
            <ul className="tm-fw-ink__points">
              {PULSE_POINTS.map((point) => (
                <li key={point.term}>
                  <StatusDot tone={point.tone}>
                    {point.term} — {point.detail}
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
      <WebSection spacing="compact" className="tm-fw-facts-band" aria-label="Product facts">
        <StatBand stats={WORK_STATS} />
      </WebSection>

      {/* 7 · Templates */}
      <WebSection id="templates" className="tm-fw-templates-band" aria-labelledby="templates-title">
        <SectionHeader
          id="templates-title"
          eyebrow="Templates"
          title="Start from a plan that already works."
          lede="Milestones, work items, review steps and client touchpoints, ready to adjust before anything is created."
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
          eyebrow="FAQ"
          title="Questions teams ask first."
          lede="Short answers about visibility, structure and moving your work in."
        />
        <div className="tm-web-faq-list tm-fw-faq__list">
          {FAQS.map((item, index) => (
            <FaqRow key={item.question} {...item} defaultOpen={index === 0} />
          ))}
        </div>
      </WebSection>

      {/* 9 · CTA band (footer comes from the website chrome) */}
      <CtaBand
        title="Turn your next request into owned work."
        lede="Start free with your team, invite clients at no cost, and watch one request travel all the way to approval."
        note="Free for 2 people · Client users always free · No credit card"
        secondary={{ label: 'See it in a demo', href: DEMO_HREF }}
      />
    </div>
  );
}
