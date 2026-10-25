'use client';

import Link from '../../WebLink';
import { Avatar } from '@tmanage/ui';
import type { ApiClient } from '../../../../lib/api/client';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { FaqRow, SectionHeader, WebSection } from '../../sections';
import { WebIcon } from '../../WebIcon';
import { DemoRequestForm } from './DemoRequestForm';
import './contact.css';

const CHECKLIST: readonly MessageKey[] = [
  'ContactPage.checklistFlow',
  'ContactPage.checklistPortal',
  'ContactPage.checklistPricing',
  'ContactPage.checklistSecurity',
];

interface OtherWay {
  titleKey: MessageKey;
  bodyKey: MessageKey;
  href: string;
}

/** The three "Other ways" cards: the whole card is the link, with the outline orb at the end. */
export const OTHER_WAYS: readonly OtherWay[] = [
  {
    titleKey: 'ContactPage.salesTitle',
    bodyKey: 'ContactPage.salesCardBody',
    href: 'mailto:sales@tmanage.app',
  },
  { titleKey: 'ContactPage.supportTitle', bodyKey: 'ContactPage.supportCardBody', href: '/faq' },
  {
    titleKey: 'ContactPage.securityTitle',
    bodyKey: 'ContactPage.securityCardBody',
    href: '/security',
  },
];

const FAQ: readonly { questionKey: MessageKey; answerKey: MessageKey }[] = [
  { questionKey: 'ContactPage.faqRecordedQ', answerKey: 'ContactPage.faqRecordedA' },
  { questionKey: 'ContactPage.faqTryQ', answerKey: 'ContactPage.faqTryA' },
  { questionKey: 'ContactPage.faqArabicQ', answerKey: 'ContactPage.faqArabicA' },
];

/**
 * WEB-17 Book a demo (`/contact`), built to the round-2 Figma frame (T-Manage Website, node
 * 308:42): copy, checklist and quote beside the form card; three "Other ways" link cards; the
 * three-question FAQ. The form keeps the existing public contact API and its rate limit. No CTA
 * band on this page, by spec.
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
                  <WebIcon name="check" size={16} className="tm-web-contact-checklist__icon" />
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
      <WebSection spacing="compact" aria-labelledby="contact-ways-title">
        <SectionHeader
          align="center"
          id="contact-ways-title"
          eyebrow={t('ContactPage.waysEyebrowFull')}
          title={t('ContactPage.waysHeading')}
          lede={t('ContactPage.waysLede')}
        />
        <ul className="tm-web-contact-ways">
          {OTHER_WAYS.map((way) => (
            <li key={way.titleKey}>
              <Link href={way.href} className="tm-web-contact-way">
                <span className="tm-web-contact-way__text">
                  <span className="tm-web-contact-way__title">{t(way.titleKey)}</span>
                  <span className="tm-web-contact-way__body">{t(way.bodyKey)}</span>
                </span>
                <span
                  className="tm-web-orb tm-web-orb--outline tm-web-orb--default"
                  aria-hidden="true"
                >
                  <WebIcon name="plus" size={14} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </WebSection>

      {/* 4 · FAQ */}
      <WebSection spacing="compact" aria-labelledby="contact-faq-title">
        <SectionHeader
          align="center"
          id="contact-faq-title"
          eyebrow={t('ContactPage.faqEyebrow')}
          title={t('ContactPage.faqHeading')}
        />
        <div className="tm-web-faq-list tm-web-contact-faq">
          {FAQ.map((item) => (
            <FaqRow
              key={item.questionKey}
              question={t(item.questionKey)}
              answer={t(item.answerKey)}
              defaultOpen
            />
          ))}
        </div>
      </WebSection>
    </div>
  );
}

/** The small placeholder quote card (sunken, no line), as drawn beside the form. */
function QuoteCard() {
  const t = useT();
  return (
    <figure className="tm-web-contact-quote">
      <blockquote className="tm-web-contact-quote__text">
        <p>{t('ContactPage.quoteBody')}</p>
      </blockquote>
      <figcaption className="tm-web-contact-quote__by">
        <Avatar name="J R" audience="client" decorative />
        <span className="tm-web-contact-quote__who">
          <span className="tm-web-contact-quote__role">{t('ContactPage.quoteAuthorRole')}</span>
          <span className="tm-web-contact-quote__org">{t('ContactPage.quoteAuthorOrg')}</span>
        </span>
      </figcaption>
    </figure>
  );
}
