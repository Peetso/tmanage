'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ButtonLink,
  CtaBand,
  Eyebrow,
  GraphCard,
  ProductVisualFrame,
  SectionHeader,
  TestimonialCard,
  WebSection,
} from '../../index';
import { cx } from '../../primitives';
import {
  CalendarScene,
  ChannelScene,
  ChannelsScene,
  DigestScene,
  MeetingScene,
  MessageToWorkScene,
} from './scenes';
import './features-communication.css';

/**
 * Features · Chat & calendar (SITE-SPEC "PAGE: Features · Chat & calendar", WEB-04).
 * No Figma frame exists for this page; it is drawn in the same visual language as the designed
 * Features · Docs page, from the shared website layer and packages/ui parts only.
 */

const ANCHORS = [
  { label: 'Channels', href: '#channels' },
  { label: 'Threads', href: '#threads' },
  { label: 'Message to work', href: '#message-to-work' },
  { label: 'Calendar', href: '#calendar' },
  { label: 'Meetings', href: '#meetings' },
] as const;

const QUIET = [
  {
    icon: 'layers',
    title: 'Bundled notifications',
    body: 'One update per object, not ten pings.',
  },
  {
    icon: 'shield',
    title: 'Quiet hours',
    body: 'Respected unless something is security-critical.',
  },
  {
    icon: 'list',
    title: 'Daily digest',
    body: 'Everything you missed, ranked by consequence.',
  },
] as const;

/**
 * A feature row in the designed pages' form: mono eyebrow with the lime dot, Heading/Page title,
 * Body/LG copy, and the product visual on a radius/feature backdrop (sunken or lime tint).
 */
function Row({
  eyebrow,
  title,
  titleId,
  body,
  visual,
  reverse = false,
  backdrop = 'sunken',
  id,
  className,
}: {
  eyebrow: string;
  title: string;
  titleId: string;
  body: string;
  visual: ReactNode;
  reverse?: boolean;
  backdrop?: 'sunken' | 'lime';
  id?: string;
  className?: string;
}) {
  return (
    <div className={cx('tm-web-feature', reverse && 'tm-web-feature--reverse', className)} id={id}>
      <div className="tm-web-feature__text">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="tm-web-feature__title" id={titleId}>
          {title}
        </h2>
        <p className="tm-web-feature__body">{body}</p>
      </div>
      <ProductVisualFrame
        className={cx('tm-wc-visual', backdrop === 'lime' && 'tm-wc-visual--lime')}
      >
        {visual}
      </ProductVisualFrame>
    </div>
  );
}

export function FeaturesCommunicationPage() {
  return (
    <div className="tm-wc-page">
      {/* 2 · Hero */}
      <WebSection className="tm-wc-hero-section" aria-labelledby="wc-hero-title">
        <div className="tm-wc-hero">
          <SectionHeader
            as="h1"
            size="page"
            id="wc-hero-title"
            eyebrow="Features · Talk & meet"
            title="Conversations that end in commitments."
            lede="Channels, threads and meetings that produce tasks, decisions and owners — not more scrolling."
          >
            <div className="tm-wc-hero__actions">
              <ButtonLink href="/sign-in" tone="lime">
                Start free
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                Book a demo
              </ButtonLink>
            </div>
            <nav className="tm-wc-anchors" aria-label="On this page">
              {ANCHORS.map((anchor, index) => (
                <Link
                  key={anchor.href}
                  href={anchor.href}
                  className={cx('tm-web-chip', 'tm-wc-anchor', index === 0 && 'tm-web-chip--on')}
                >
                  {anchor.label}
                </Link>
              ))}
            </nav>
          </SectionHeader>
          <div className="tm-wc-hero__visual">
            <ChannelScene />
          </div>
        </div>
      </WebSection>

      {/* 3 · Channels & DMs */}
      <WebSection id="channels" aria-labelledby="wc-channels-title">
        <Row
          id="threads"
          eyebrow="Channels & DMs"
          titleId="wc-channels-title"
          title="Project channels with the context built in."
          body="Every project gets its channel. Mentions, reactions, files and edit history work the way your team expects."
          visual={<ChannelsScene />}
        />
      </WebSection>

      {/* 4 · Message to work (signature) */}
      <WebSection id="message-to-work" aria-labelledby="wc-m2w-title">
        <Row
          reverse
          backdrop="lime"
          eyebrow="Message to work"
          titleId="wc-m2w-title"
          title="Turn a message into a task in one move."
          body="Choose task, request or decision. Confirm owner, date and audience. The original message stays linked forever."
          visual={<MessageToWorkScene />}
        />
      </WebSection>

      {/* 5 · Quiet by design */}
      <WebSection className="tm-wc-quiet" aria-labelledby="wc-quiet-title">
        <SectionHeader
          align="center"
          id="wc-quiet-title"
          eyebrow="Quiet by design"
          title="Fewer pings. Nothing that matters missed."
          lede="Notifications follow the work, not the chatter — so people can focus and still trust they will hear about what counts."
        />
        <div className="tm-wc-grid3">
          {QUIET.map((card) => (
            <GraphCard key={card.title} icon={card.icon} title={card.title} body={card.body} />
          ))}
        </div>
      </WebSection>

      {/* 6 · Calendar */}
      <WebSection id="calendar" aria-labelledby="wc-calendar-title">
        <Row
          className="tm-wc-row-cal"
          eyebrow="Calendar"
          titleId="wc-calendar-title"
          title="Your time and your commitments on one calendar."
          body="Personal and project calendars with milestones, reviews and focus blocks."
          visual={<CalendarScene />}
        />
      </WebSection>

      {/* 7 · Meetings */}
      <WebSection id="meetings" spacing="flush" aria-labelledby="wc-meetings-title">
        <Row
          reverse
          eyebrow="Meetings"
          titleId="wc-meetings-title"
          title="A meeting closes with owners, not loose notes."
          body="Agenda, notes, decisions and actions are linked objects. Every action lands in someone's work."
          visual={<MeetingScene />}
        />
      </WebSection>

      {/* 8 · Testimonial band */}
      <WebSection spacing="compact" aria-label="What a design partner says">
        <div className="tm-wc-quote">
          <TestimonialCard
            tone="ink"
            quote="We used to lose half our decisions in chat. Now they have a home."
            author="Studio lead"
            org="Design partner · Agency"
            note=""
          />
        </div>
      </WebSection>

      {/* 9 · CTA band */}
      <CtaBand
        title="Let the next conversation end with an owner and a date."
        visual={<DigestScene />}
      />
    </div>
  );
}
