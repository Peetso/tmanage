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

/**
 * Solutions · In-house teams — `/solutions/in-house`, built to the approved design
 * (shots/10-solutions-inhouse.png) and SITE-SPEC. Sections: hero, pain → answer, workflow,
 * three alternating rows, story card, CTA band. Nav and footer come from the route group.
 */

const PAINS = [
  {
    today: 'Requests in DMs and hallways',
    answer: 'One intake per team',
    body: 'Every team gets its own request form. Asks land in one inbox with a requester, a need-by date and a clear owner.',
  },
  {
    today: 'Priorities change every week',
    answer: 'Committed vs desired dates, visible to all',
    body: 'Stakeholders see the date they asked for next to the date you committed to, so trade-offs are a conversation, not a surprise.',
  },
  {
    today: 'Leadership asks for status',
    answer: 'Portfolio exceptions, not reports',
    body: 'Leaders see only what is late, blocked or waiting on them. Everything on track stays quiet.',
  },
] as const;

const STEPS: readonly {
  title: string;
  body: string;
  state: CapsuleState;
  label: string;
}[] = [
  {
    title: 'Request',
    body: 'Stakeholders ask through their team’s form, not a DM.',
    state: 'done',
    label: 'Done',
  },
  {
    title: 'Triage',
    body: 'Your lead sorts, merges and sets a need-by date.',
    state: 'done',
    label: 'Done',
  },
  {
    title: 'Plan',
    body: 'Owner, committed date and capacity agreed in one place.',
    state: 'current',
    label: 'In progress',
  },
  {
    title: 'Deliver',
    body: 'Work moves on a board stakeholders can follow without a status meeting.',
    state: 'future',
    label: 'Next week',
  },
  {
    title: 'Review',
    body: 'The requester approves the result from a link, and the request closes.',
    state: 'client',
    label: 'Stakeholder review',
  },
];

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
  return (
    <div className="tm-inh">
      {/* Hero */}
      <WebSection tone="surface" className="tm-inh-hero" aria-labelledby="inh-hero-title">
        <div className="tm-inh-hero__grid">
          <div className="tm-inh-hero__text">
            <Badge className="tm-inh-eyebrow">For in-house teams</Badge>
            <h1 id="inh-hero-title" className="tm-metric__value tm-inh-hero__title">
              Treat internal stakeholders like clients — with the same clarity.
            </h1>
            <p className="tm-inh-hero__lede">
              Requests, priorities and status for every team you serve, in one place your
              stakeholders can actually read.
            </p>
            <div className="tm-inh-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                Book a demo
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
          eyebrow="Why in-house teams switch"
          title="Internal work deserves a real front door."
          lede="Three things in-house leads tell us slow them down, and how TManage answers each one."
        />
        <ul className="tm-inh-pains">
          {PAINS.map((pain) => (
            <li key={pain.today} className="tm-inh-pain">
              <Badge>Today</Badge>
              <p className="tm-inh-pain__today">{pain.today}</p>
              <div className="tm-inh-pain__answer">
                <p className="tm-metric__label tm-inh-pain__with">
                  <WebIcon name="check" size={14} />
                  With TManage
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
          eyebrow="How internal work flows"
          title="From a hallway ask to a reviewed result."
          lede="Each stage hands the next one its context, so nobody asks the same question twice."
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
      <WebSection aria-label="What in-house teams get" className="tm-inh-rows">
        <Row
          kicker="Intake"
          title="A front door for every team."
          body="Give marketing, finance, legal and operations their own request form. Asks arrive structured and routed to the right owner."
          checks={[
            'A request form per team, with the fields you need',
            'Triage with merge, decline and need-by dates',
            'Requesters see status without chasing you',
          ]}
          link={{ label: 'Explore requests', href: '/features/work' }}
          visual={<IntakeFormScene />}
        />
        <Row
          reverse
          kicker="Review"
          title="Stakeholder review without accounts everywhere."
          body="Send a review link to the person who asked. They comment, approve or ask for changes, and every answer stays with the work."
          checks={[
            'Approve or request changes from one link',
            'Versioned reviews that are never overwritten',
            'Guest reviewers are always free',
          ]}
          link={{ label: 'Explore approvals', href: '/features/knowledge' }}
          visual={<StakeholderReviewScene />}
        />
        <Row
          kicker="Capacity"
          title="Capacity planning without scoring people."
          body="See load by team and week in committed hours, not productivity scores. Rebalance before a date slips, not after."
          checks={[
            'Workload by team and week',
            'Time off and availability built in',
            'No individual rankings or scorecards',
          ]}
          link={{ label: 'Explore workload', href: '/features/insights' }}
          visual={<WorkloadScene />}
        />
      </WebSection>

      {/* Story card */}
      <WebSection tone="sunken" aria-label="Customer story">
        <figure className="tm-inh-story">
          <div className="tm-inh-story__main">
            <Badge>Customer story · coming soon</Badge>
            <blockquote className="tm-web-feature__title tm-inh-story__quote">
              <p>
                “An in-house operations team will tell how one intake form ended the Monday-morning
                priority scramble.”
              </p>
            </blockquote>
            <figcaption className="tm-inh-story__by">
              <Avatar name="H O" audience="client" decorative className="tm-inh-story__avatar" />
              <span className="tm-inh-story__who">
                <span className="tm-metric__label tm-inh-story__name">Team lead name</span>
                <span className="tm-inh-story__org">
                  Head of operations, design-partner company
                </span>
              </span>
            </figcaption>
          </div>
          <dl className="tm-inh-story__facts">
            <div className="tm-inh-story__fact">
              <dt>
                <span className="tm-inh-story__bar" aria-hidden="true" />
                <span className="tm-visually-hidden">Figure to come: </span>
                fewer status requests to the delivery team
              </dt>
              <dd>Measured with the design partner. Published with the story.</dd>
            </div>
            <div className="tm-inh-story__fact">
              <dt>
                <span className="tm-inh-story__bar" aria-hidden="true" />
                <span className="tm-visually-hidden">Figure to come: </span>
                requests triaged within one working day
              </dt>
              <dd>Shared only with the partner’s consent.</dd>
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
                Give every team you serve one front door.
              </h2>
              <p className="tm-web-cta__lede">
                Start free with your team. Invite stakeholders when the first request comes in.
              </p>
              <div className="tm-web-cta__actions">
                <ButtonLink href={SIGN_UP_HREF} tone="lime">
                  Start free
                </ButtonLink>
                <ButtonLink href="/contact" tone="outline-ink">
                  Book a demo
                </ButtonLink>
              </div>
              <p className="tm-web-cta__note">
                No credit card · Stakeholder reviewers are always free
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
