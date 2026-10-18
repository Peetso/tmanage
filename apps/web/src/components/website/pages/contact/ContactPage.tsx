'use client';

import { Avatar, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../../../lib/api/client';
import { ArrowLink, IconOrb } from '../../primitives';
import { FaqRow, SectionHeader, WebSection, type FaqItem } from '../../sections';
import type { WebIconName } from '../../WebIcon';
import { DemoRequestForm } from './DemoRequestForm';
import './contact.css';

const CHECKLIST: readonly string[] = [
  'Your request-to-approval flow, mapped',
  'Client portal set up for your next project',
  'Pricing for your team size',
  'Answers for your security team',
];

interface OtherWay {
  icon: WebIconName;
  title: string;
  body: string;
  link: { label: string; href: string };
}

const OTHER_WAYS: readonly OtherWay[] = [
  {
    icon: 'briefcase',
    title: 'Talk to sales',
    body: 'Plans, seats and rollout for a larger team. Write to sales and we reply within one business day.',
    link: { label: 'sales@tmanage.app', href: 'mailto:sales@tmanage.app' },
  },
  {
    icon: 'help',
    title: 'Get support',
    body: 'Already using TManage? Answers, setup guides and how-tos live in the Help center.',
    link: { label: 'Open the Help center', href: '/faq' },
  },
  {
    icon: 'shield',
    title: 'Security questions',
    body: 'Tenancy, client access, files and audit — how isolation is enforced, in plain words.',
    link: { label: 'Read the Security page', href: '/security' },
  },
];

const FAQ: readonly FaqItem[] = [
  { question: 'Is the demo recorded?', answer: 'Only if you ask.' },
  { question: 'Can I try it first?', answer: 'Yes, the Free plan needs no card.' },
  { question: 'Do you support Arabic?', answer: 'Yes, the full product and portal.' },
];

/**
 * WEB-17 Book a demo / contact sales (`/contact`). No Figma frame yet: designed in code from
 * SITE-SPEC in the visual language of the designed pages (Security's centred section headers and
 * numbered cards, Pricing's FAQ). The form keeps the existing public contact API and its rate
 * limit. No CTA band on this page, by spec.
 */
export function ContactPage({ client }: { client?: ApiClient }) {
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
              eyebrow="BOOK A DEMO"
              title="See your own workflow in TManage."
              lede="A 30-minute walkthrough with someone who has run client delivery. Bring a real project; we'll map it live."
            />
            <ul className="tm-web-contact-checklist">
              {CHECKLIST.map((item) => (
                <li key={item} className="tm-web-contact-checklist__item">
                  <IconOrb icon="check" tone="lime" size="compact" />
                  <span>{item}</span>
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
          eyebrow="OTHER WAYS"
          title="Not ready for a demo? Reach the right person."
        />
        <ul className="tm-web-contact-ways">
          {OTHER_WAYS.map((way) => (
            <li key={way.title} className="tm-web-contact-way">
              <IconOrb icon={way.icon} tone="lime" />
              <h3 className="tm-web-contact-way__title">{way.title}</h3>
              <p className="tm-web-contact-way__body">{way.body}</p>
              <ArrowLink href={way.link.href} underline={false}>
                {way.link.label}
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
          eyebrow="FAQ"
          title="Before you book."
          lede="Three things people ask us first."
        />
        <div className="tm-web-faq-list tm-web-contact-faq">
          {FAQ.map((item) => (
            <FaqRow key={item.question} {...item} />
          ))}
        </div>
      </WebSection>
    </div>
  );
}

/** The spec's small quote card — a design-partner quote, shown without any working note. */
function QuoteCard() {
  return (
    <figure className="tm-web-contact-quote">
      <blockquote className="tm-web-contact-quote__text">
        <p>
          “We brought a live client project to the call and left with the approval flow already
          mapped.”
        </p>
      </blockquote>
      <figcaption className="tm-web-contact-quote__by">
        <Avatar name="D P" audience="client" decorative />
        <span className="tm-web-contact-quote__who">
          <span className="tm-web-contact-quote__role">Delivery lead</span>
          <span className="tm-web-contact-quote__org">Design partner · Agency</span>
        </span>
        <StateCapsule state="client">Demo call</StateCapsule>
      </figcaption>
    </figure>
  );
}
