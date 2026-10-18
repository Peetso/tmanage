'use client';

import Link from 'next/link';
import {
  ButtonLink,
  CalloutPin,
  FeatureRow,
  GraphCard,
  LinkCard,
  ProductVisualFrame,
  SectionHeader,
  WebSection,
  type WebIconName,
} from '../../index';
import {
  AdminScene,
  AppShellScene,
  BilingualScene,
  InboxScene,
  PortalScene,
  WorkListScene,
} from './ProductPageScenes';
import './product.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * WEB-02 · Product overview (`/product`). Copy is SITE-SPEC.md "PAGE: Product overview"; the
 * layout follows the approved Figma frame (shots/product.png). Every section is composed from
 * the shared website layer; the product visuals are mini TManage screens, not screenshots.
 */

const MODES = [
  {
    id: 'team-workspace',
    label: 'Team workspace',
    caption: 'Team workspace — lists, boards, chat and approvals on one model.',
  },
  {
    id: 'focus-space',
    label: 'Focus space',
    caption: 'Focus space — My Day and an inbox that only holds what needs you.',
  },
  {
    id: 'client-portal',
    label: 'Client portal',
    caption: 'Client portal — the client-visible slice, generated from an allowlist.',
  },
  {
    id: 'control-center',
    label: 'Control center',
    caption: 'Control center — roles, templates and policy with an impact preview.',
  },
] as const;

const GRAPH: readonly { icon: WebIconName; title: string; body: string }[] = [
  { icon: 'id', title: 'Identity', body: 'A stable ID and a home project.' },
  {
    icon: 'person',
    title: 'Responsibility',
    body: 'One owner, named collaborators, clear authority.',
  },
  { icon: 'calendar', title: 'Time', body: 'Desired, committed and forecast dates kept apart.' },
  {
    icon: 'globe',
    title: 'Audience',
    body: 'Internal, client visible, or client action required.',
  },
  { icon: 'link', title: 'Context', body: 'Linked messages, docs and meetings.' },
  { icon: 'check', title: 'Evidence', body: 'Versions, approvals and audit events.' },
];

const REPLACED = [
  'Status meetings',
  'Screenshots pasted into email',
  '‘Which version did they approve?’',
  'Re-typing requests into tasks',
] as const;

const FEATURE_INDEX = [
  { title: 'Work & requests', hint: 'Every ask becomes owned work', href: '/features/work' },
  {
    title: 'Projects & portfolio',
    hint: 'Milestones that move on evidence',
    href: '/features/work#projects',
  },
  { title: 'Chat', hint: 'Threads that turn into tasks', href: '/features/communication' },
  {
    title: 'Calendar & meetings',
    hint: 'Meetings that end with owners',
    href: '/features/communication#calendar',
  },
  { title: 'Docs & decisions', hint: 'Context beside the work', href: '/features/knowledge' },
  {
    title: 'Approvals',
    hint: 'One decision, one exact version',
    href: '/features/knowledge#approvals',
  },
  {
    title: 'Client portal',
    hint: 'A view clients understand in 30 seconds',
    href: '/client-portal',
  },
  { title: 'Insights', hint: 'Health you can explain', href: '/features/insights' },
  {
    title: 'Automations',
    hint: 'Remove repeat coordination safely',
    href: '/features/insights#automations',
  },
] as const;

/**
 * Web/CTA band as specified (SITE-SPEC "Web/CTA band", 02-product): the centred text-only ink
 * panel with "Start free" (Lime) and "Book a demo" (Outline on ink). Composed from the shared
 * band classes and ButtonLink, because the shared CtaBand's secondary slot is a play capsule.
 */
function ProductCtaBand() {
  return (
    <section className="tm-web-cta-section tm-pp-cta" aria-labelledby="pp-cta-title">
      <div className="tm-web-container">
        <div className="tm-web-cta tm-web-cta--text">
          <div className="tm-web-cta__text">
            <h2 id="pp-cta-title" className="tm-web-cta__title">
              Bring the next client project into one story.
            </h2>
            <p className="tm-web-cta__lede">
              Start free with your team. Invite your client when the first deliverable is ready.
            </p>
            <div className="tm-web-cta__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline-ink">
                Book a demo
              </ButtonLink>
            </div>
            <p className="tm-web-cta__note">No credit card · Client users are always free</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ProductPage() {
  return (
    <div className="tm-pp">
      {/* 2–3 · Hero and the big product visual */}
      <WebSection className="tm-pp-hero" aria-labelledby="pp-hero-title">
        <SectionHeader
          as="h1"
          size="page"
          align="center"
          id="pp-hero-title"
          eyebrow="The product"
          title="One work graph. Four ways to use it."
          lede="TManage is one system with a dense team workspace, a quiet focus space, a simple client portal and a control center for the people who run it."
        >
          <div className="tm-pp-hero__actions">
            <ButtonLink href={SIGN_UP_HREF} tone="lime">
              Start free
            </ButtonLink>
            <ButtonLink href="/contact" tone="outline">
              Book a demo
            </ButtonLink>
          </div>
        </SectionHeader>
        <nav className="tm-pp-anchors" aria-label="Four ways to use TManage">
          <ul className="tm-pp-anchors__list">
            {MODES.map((mode, index) => (
              <li key={mode.id}>
                <Link href={`#${mode.id}`} className="tm-pp-anchor">
                  <CalloutPin n={index + 1} />
                  <span>{mode.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <ProductVisualFrame tone="ink" className="tm-pp-stage">
          <AppShellScene />
        </ProductVisualFrame>
        <ol className="tm-pp-captions">
          {MODES.map((mode, index) => (
            <li key={mode.id} className="tm-pp-caption">
              <CalloutPin n={index + 1} />
              <span>{mode.caption}</span>
            </li>
          ))}
        </ol>
      </WebSection>

      {/* 4 · The work graph */}
      <WebSection aria-labelledby="pp-graph-title">
        <SectionHeader
          id="pp-graph-title"
          eyebrow="The work graph"
          title="Every object knows where it came from."
          lede="Requests, tasks, decisions, deliverables and approvals share one core: owner, state, dates, audience, context and evidence."
        />
        <div className="tm-pp-graph">
          {GRAPH.map((item) => (
            <GraphCard key={item.title} {...item} />
          ))}
        </div>
      </WebSection>

      {/* 5 · Four modes */}
      <WebSection aria-labelledby="pp-modes-title" className="tm-pp-modes">
        <SectionHeader
          id="pp-modes-title"
          align="center"
          eyebrow="Four modes"
          title="Same work. The view each person needs."
          lede="Every mode reads the same objects, so nothing is copied from one place to another."
        />
        <FeatureRow
          id="team-workspace"
          step={1}
          label="Team workspace"
          title="Dense enough to actually run delivery."
          body="Chat, work, docs, files and approvals on one model, with lists, boards and timelines over the same items."
          link={{ label: 'Explore work & requests', href: '/features/work' }}
          visual={<WorkListScene />}
        />
        <FeatureRow
          id="focus-space"
          step={2}
          label="Focus space"
          title="A quieter place to do the work."
          body="My Day, an actionable inbox and bundled notifications that respect quiet hours."
          link={{ label: 'See My Day and the inbox', href: '/features/communication' }}
          visual={<InboxScene />}
          reverse
        />
        <FeatureRow
          id="client-portal"
          step={3}
          label="Client portal"
          title="Simpler, warmer, action-first."
          body="Clients see overview, their actions, timeline, deliverables, updates, files and people. Nothing else."
          link={{ label: 'Explore the client portal', href: '/client-portal' }}
          visual={<PortalScene />}
        />
        <FeatureRow
          id="control-center"
          step={4}
          label="Control center"
          title="Governance with an impact preview."
          body="Roles, templates, automations, security, data and billing — every tenant-wide change shows what it will affect first."
          link={{ label: 'See security & control', href: '/security' }}
          visual={<AdminScene />}
          reverse
        />
      </WebSection>

      {/* 6 · What it replaces */}
      <WebSection tone="sunken" spacing="compact" aria-labelledby="pp-replaces-title">
        <SectionHeader
          id="pp-replaces-title"
          align="center"
          title="What disappears when the story is connected."
          lede="Each of these is replaced by a link to the same object everyone already sees."
        />
        <ul className="tm-pp-replaced">
          {REPLACED.map((item) => (
            <li key={item} className="tm-web-chip tm-pp-replaced__chip">
              <s>{item}</s>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 7 · Feature index */}
      <WebSection aria-labelledby="pp-index-title">
        <SectionHeader
          id="pp-index-title"
          eyebrow="Feature index"
          title="Go deeper on any part of the work."
          lede="Each page shows one part of the product in detail, with the same seed project throughout."
        />
        <div className="tm-pp-index">
          {FEATURE_INDEX.map((item) => (
            <LinkCard key={item.title} {...item} />
          ))}
        </div>
      </WebSection>

      {/* 8 · Bilingual band */}
      <WebSection spacing="flush" className="tm-pp-bilingual-section">
        <FeatureRow
          label="English and Arabic"
          title="Built for English and Arabic from day one."
          body="Every screen is mirrored for right-to-left, with Arabic written as product language — not literal translation."
          visual={<BilingualScene />}
        />
      </WebSection>

      {/* 9 · CTA band (10 · footer comes from the website layout) */}
      <ProductCtaBand />
    </div>
  );
}
