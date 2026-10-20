'use client';

import { Avatar, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../../../lib/api/client';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { ArrowLink, IconOrb } from '../../primitives';
import { FaqRow, SectionHeader, WebSection } from '../../sections';
import type { WebIconName } from '../../WebIcon';
import { DemoRequestForm } from './DemoRequestForm';
import './contact.css';

const CHECKLIST: readonly MessageKey[] = [
  'ContactPage.checklistFlow',
  'ContactPage.checklistPortal',
  'ContactPage.checklistPricing',
  'ContactPage.checklistSecurity',
];

interface OtherWay {
  icon: WebIconName;
  titleKey: MessageKey;
  bodyKey: MessageKey;
  link: { label?: string; labelKey?: MessageKey; href: string };
}

const OTHER_WAYS: readonly OtherWay[] = [
  {
    icon: 'briefcase',
    titleKey: 'ContactPage.salesTitle',
    bodyKey: 'ContactPage.salesBody',
    link: { label: 'sales@tmanage.app', href: 'mailto:sales@tmanage.app' },
  },
  {
    icon: 'help',
    titleKey: 'ContactPage.supportTitle',
    bodyKey: 'ContactPage.supportBody',
    link: { labelKey: 'ContactPage.supportLink', href: '/faq' },
  },
  {
    icon: 'shield',
    titleKey: 'ContactPage.securityTitle',
    bodyKey: 'ContactPage.securityBody',
    link: { labelKey: 'ContactPage.securityLink', href: '/security' },
  },
];

const FAQ: readonly { questionKey: MessageKey; answerKey: MessageKey }[] = [
  { questionKey: 'ContactPage.faqRecordedQ', answerKey: 'ContactPage.faqRecordedA' },
  { questionKey: 'ContactPage.faqTryQ', answerKey: 'ContactPage.faqTryA' },
  { questionKey: 'ContactPage.faqArabicQ', answerKey: 'ContactPage.faqArabicA' },
];

/**
 * WEB-17 Book a demo / contact sales (`/contact`). No Figma frame yet: designed in code from
 * SITE-SPEC in the visual language of the designed pages (Security's centred section headers and
 * numbered cards, Pricing's FAQ). The form keeps the existing public contact API and its rate
 * limit. No CTA band on this page, by spec.
 */
export function ContactPage({ client }: { client?: ApiClient }) {
  const t = useT();
  return (
    <div className="tm-web-contact">
      {/* 2 · Two-column hero: copy + checklist + quote, form card */}
      <WebSection className="tm-web-contact-hero" aria-labelledby="contact-hero-title">
        <div className="tm-web-contact-hero__grid">
          <div className="tm-web-contact-hero__copy">
            <SectionHeader
              as="h1"
              size="page"
              id="contact-hero-title"
              eyebrow={t('ContactPage.heroEyebrow')}
              title={t('ContactPage.heroTitle')}
              lede={t('ContactPage.heroLede')}
            />
            <ul className="tm-web-contact-checklist">
              {CHECKLIST.map((item) => (
                <li key={item} className="tm-web-contact-checklist__item">
                  <IconOrb icon="check" tone="lime" size="compact" />
                  <span>{t(item)}</span>
                </li>
              ))}
            </ul>
            <QuoteCard />
          </div>
          <div className="tm-web-contact-hero__form">
            {client ? <DemoRequestForm client={client} /> : <DemoRequestForm />}
          </div>
        </div>
      </WebSection>

      {/* 3 · Other ways to reach us */}
      <WebSection tone="sunken" aria-labelledby="contact-ways-title">
        <SectionHeader
          id="contact-ways-title"
          eyebrow={t('ContactPage.waysEyebrow')}
          title={t('ContactPage.waysTitle')}
        />
        <ul className="tm-web-contact-ways">
          {OTHER_WAYS.map((way) => (
            <li key={way.titleKey} className="tm-web-contact-way">
              <IconOrb icon={way.icon} tone="lime" />
              <h3 className="tm-web-contact-way__title">{t(way.titleKey)}</h3>
              <p className="tm-web-contact-way__body">{t(way.bodyKey)}</p>
              <ArrowLink href={way.link.href} underline={false}>
                {way.link.labelKey ? t(way.link.labelKey) : way.link.label}
              </ArrowLink>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 4 · FAQ */}
      <WebSection aria-labelledby="contact-faq-title">
        <SectionHeader
          align="center"
          id="contact-faq-title"
          eyebrow={t('ContactPage.faqEyebrow')}
          title={t('ContactPage.faqTitle')}
          lede={t('ContactPage.faqLede')}
        />
        <div className="tm-web-faq-list tm-web-contact-faq">
          {FAQ.map((item) => (
            <FaqRow
              key={item.questionKey}
              question={t(item.questionKey)}
              answer={t(item.answerKey)}
            />
          ))}
        </div>
      </WebSection>
    </div>
  );
}

/** The spec's small quote card — a design-partner quote, shown without any working note. */
function QuoteCard() {
  const t = useT();
  return (
    <figure className="tm-web-contact-quote">
      <blockquote className="tm-web-contact-quote__text">
        <p>{t('ContactPage.quoteText')}</p>
      </blockquote>
      <figcaption className="tm-web-contact-quote__by">
        <Avatar name="D P" audience="client" decorative />
        <span className="tm-web-contact-quote__who">
          <span className="tm-web-contact-quote__role">{t('ContactPage.quoteRole')}</span>
          <span className="tm-web-contact-quote__org">{t('ContactPage.quoteOrg')}</span>
        </span>
        <StateCapsule state="client">{t('ContactPage.quoteCapsule')}</StateCapsule>
      </figcaption>
    </figure>
  );
}
