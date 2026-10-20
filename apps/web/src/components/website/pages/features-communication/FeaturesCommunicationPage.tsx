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
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import {
  CalendarScene,
  ChannelScene,
  ChannelsScene,
  DigestScene,
  MeetingScene,
  MessageToWorkScene,
} from './scenes';
import './features-communication.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/**
 * Features · Chat & calendar (SITE-SPEC "PAGE: Features · Chat & calendar", WEB-04).
 * No Figma frame exists for this page; it is drawn in the same visual language as the designed
 * Features · Docs page, from the shared website layer and packages/ui parts only.
 */

const ANCHORS: readonly { labelKey: MessageKey; href: string }[] = [
  { labelKey: 'FeaturesCommunicationPage.anchorChannels', href: '#channels' },
  { labelKey: 'FeaturesCommunicationPage.anchorThreads', href: '#threads' },
  { labelKey: 'FeaturesCommunicationPage.anchorMessageToWork', href: '#message-to-work' },
  { labelKey: 'FeaturesCommunicationPage.anchorCalendar', href: '#calendar' },
  { labelKey: 'FeaturesCommunicationPage.anchorMeetings', href: '#meetings' },
];

const QUIET: readonly {
  icon: 'layers' | 'shield' | 'list';
  titleKey: MessageKey;
  bodyKey: MessageKey;
}[] = [
  {
    icon: 'layers',
    titleKey: 'FeaturesCommunicationPage.quietBundledTitle',
    bodyKey: 'FeaturesCommunicationPage.quietBundledBody',
  },
  {
    icon: 'shield',
    titleKey: 'FeaturesCommunicationPage.quietHoursTitle',
    bodyKey: 'FeaturesCommunicationPage.quietHoursBody',
  },
  {
    icon: 'list',
    titleKey: 'FeaturesCommunicationPage.quietDigestTitle',
    bodyKey: 'FeaturesCommunicationPage.quietDigestBody',
  },
];

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
  const t = useT();
  return (
    <div className="tm-wc-page">
      {/* 2 · Hero */}
      <WebSection className="tm-wc-hero-section" aria-labelledby="wc-hero-title">
        <div className="tm-wc-hero">
          <SectionHeader
            as="h1"
            size="page"
            id="wc-hero-title"
            eyebrow={t('FeaturesCommunicationPage.heroEyebrow')}
            title={t('FeaturesCommunicationPage.heroTitle')}
            lede={t('FeaturesCommunicationPage.heroLede')}
          >
            <div className="tm-wc-hero__actions">
              <ButtonLink href={SIGN_UP_HREF} tone="lime">
                {t('FeaturesCommunicationPage.startFree')}
              </ButtonLink>
              <ButtonLink href="/contact" tone="outline">
                {t('FeaturesCommunicationPage.bookDemo')}
              </ButtonLink>
            </div>
            <nav className="tm-wc-anchors" aria-label={t('FeaturesCommunicationPage.anchorsAria')}>
              {ANCHORS.map((anchor, index) => (
                <Link
                  key={anchor.href}
                  href={anchor.href}
                  className={cx('tm-web-chip', 'tm-wc-anchor', index === 0 && 'tm-web-chip--on')}
                >
                  {t(anchor.labelKey)}
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
          eyebrow={t('FeaturesCommunicationPage.channelsEyebrow')}
          titleId="wc-channels-title"
          title={t('FeaturesCommunicationPage.channelsTitle')}
          body={t('FeaturesCommunicationPage.channelsBody')}
          visual={<ChannelsScene />}
        />
      </WebSection>

      {/* 4 · Message to work (signature) */}
      <WebSection id="message-to-work" aria-labelledby="wc-m2w-title">
        <Row
          reverse
          backdrop="lime"
          eyebrow={t('FeaturesCommunicationPage.m2wEyebrow')}
          titleId="wc-m2w-title"
          title={t('FeaturesCommunicationPage.m2wTitle')}
          body={t('FeaturesCommunicationPage.m2wBody')}
          visual={<MessageToWorkScene />}
        />
      </WebSection>

      {/* 5 · Quiet by design */}
      <WebSection className="tm-wc-quiet" aria-labelledby="wc-quiet-title">
        <SectionHeader
          align="center"
          id="wc-quiet-title"
          eyebrow={t('FeaturesCommunicationPage.quietEyebrow')}
          title={t('FeaturesCommunicationPage.quietTitle')}
          lede={t('FeaturesCommunicationPage.quietLede')}
        />
        <div className="tm-wc-grid3">
          {QUIET.map((card) => (
            <GraphCard
              key={card.titleKey}
              icon={card.icon}
              title={t(card.titleKey)}
              body={t(card.bodyKey)}
            />
          ))}
        </div>
      </WebSection>

      {/* 6 · Calendar */}
      <WebSection id="calendar" aria-labelledby="wc-calendar-title">
        <Row
          className="tm-wc-row-cal"
          eyebrow={t('FeaturesCommunicationPage.calendarEyebrow')}
          titleId="wc-calendar-title"
          title={t('FeaturesCommunicationPage.calendarTitle')}
          body={t('FeaturesCommunicationPage.calendarBody')}
          visual={<CalendarScene />}
        />
      </WebSection>

      {/* 7 · Meetings */}
      <WebSection id="meetings" spacing="flush" aria-labelledby="wc-meetings-title">
        <Row
          reverse
          eyebrow={t('FeaturesCommunicationPage.meetingsEyebrow')}
          titleId="wc-meetings-title"
          title={t('FeaturesCommunicationPage.meetingsTitle')}
          body={t('FeaturesCommunicationPage.meetingsBody')}
          visual={<MeetingScene />}
        />
      </WebSection>

      {/* 8 · Testimonial band */}
      <WebSection spacing="compact" aria-label={t('FeaturesCommunicationPage.testimonialAria')}>
        <div className="tm-wc-quote">
          <TestimonialCard
            tone="ink"
            quote={t('FeaturesCommunicationPage.testimonialQuote')}
            author={t('FeaturesCommunicationPage.testimonialAuthor')}
            org={t('FeaturesCommunicationPage.testimonialOrg')}
            note=""
          />
        </div>
      </WebSection>

      {/* 9 · CTA band */}
      <CtaBand title={t('FeaturesCommunicationPage.ctaTitle')} visual={<DigestScene />} />
    </div>
  );
}
