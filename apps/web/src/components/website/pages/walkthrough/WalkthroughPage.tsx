'use client';

import type { ApiClient } from '../../../../lib/api/client';
import { useT } from '../../../../lib/i18n/use-t';
import type { MessageKey } from '../../../../lib/i18n/t';
import { SectionHeader, WebSection } from '../../sections';
import { WebIcon } from '../../WebIcon';
import { WalkthroughForm } from './WalkthroughForm';
import '../contact/contact.css';
import './walkthrough.css';

const CHECKLIST: readonly MessageKey[] = [
  'WalkthroughPage.checklistTour',
  'WalkthroughPage.checklistSwitch',
  'WalkthroughPage.checklistFuture',
  'WalkthroughPage.checklistLanguage',
];

/**
 * LANE-Q — WEB-38 Book a walkthrough (`/walkthrough`, `/ar/walkthrough`), built to the Figma frame
 * "WEB-38 Book a walkthrough" (T-Manage Website, node 760:17010): the contact page's two-column
 * hero — copy and checklist beside the form card — with no quote, "Other ways" or FAQ, by spec.
 * The outreach e-mail's "book a walkthrough" line links here.
 */
export function WalkthroughPage({ client }: { client?: ApiClient }) {
  const t = useT();
  return (
    <div className="tm-web-contact">
      <WebSection className="tm-web-contact-hero" aria-labelledby="walkthrough-hero-title">
        <div className="tm-web-contact-hero__grid">
          <div className="tm-web-contact-hero__copy">
            <SectionHeader
              as="h1"
              size="page"
              id="walkthrough-hero-title"
              eyebrow={t('WalkthroughPage.heroEyebrow')}
              title={t('WalkthroughPage.heroTitle')}
              lede={t('WalkthroughPage.heroLede')}
            />
            <ul className="tm-web-contact-checklist">
              {CHECKLIST.map((item) => (
                <li key={item} className="tm-web-contact-checklist__item">
                  <WebIcon name="check" size={16} className="tm-web-contact-checklist__icon" />
                  <span>{t(item)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="tm-web-contact-hero__form">
            {client ? <WalkthroughForm client={client} /> : <WalkthroughForm />}
          </div>
        </div>
      </WebSection>
    </div>
  );
}
