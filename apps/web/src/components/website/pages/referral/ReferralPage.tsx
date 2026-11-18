'use client';

import { InlineAlert } from '@tmanage/ui';
import { REFERRAL_PAGE_COPY } from '../../../../content/referral/referral';
import { SIGN_IN_TO_INVITE_AGENCIES } from '../../../../lib/sign-in-return';
import { ButtonLink } from '../../primitives';
import { SectionHeader, WebSection } from '../../sections';
import { useCompareLanguage } from '../compare/use-compare-language';
import './referral.css';

/**
 * 57-08 REFERRAL — "Invite an agency" (`/referral`, `/ar/referral`; Figma 724:40609 / 724:40715).
 *
 * Speaks to people who already have a workspace (review B point 10): the primary button signs
 * them in and opens Settings › People › Invite agencies; the secondary one is for newcomers. One
 * `h1`; the three steps are an ordered list, so Arabic reads 1-2-3 from the right through
 * `dir="rtl"`, never through reversed markup (point 25). The step numbers are decoration.
 */
export function ReferralPage() {
  const language = useCompareLanguage();
  const copy = REFERRAL_PAGE_COPY[language];
  return (
    <WebSection aria-labelledby="referral-title" className="tm-web-referral">
      <SectionHeader
        id="referral-title"
        as="h1"
        size="page"
        eyebrow={copy.eyebrow}
        title={copy.heading}
        lede={copy.lede}
      />
      <ol className="tm-web-referral__steps">
        {copy.steps.map((step, index) => (
          <li key={step.title} className="tm-web-referral__step">
            <span className="tm-web-referral__number" aria-hidden="true">
              {index + 1}
            </span>
            <h2 className="tm-web-referral__step-title">{step.title}</h2>
            <p className="tm-web-referral__step-body">{step.body}</p>
          </li>
        ))}
      </ol>
      <div className="tm-web-referral__actions">
        <ButtonLink href={SIGN_IN_TO_INVITE_AGENCIES} tone="ink" size="feature">
          {copy.primary}
        </ButtonLink>
        <ButtonLink href="/sign-up" tone="text" size="feature">
          {copy.secondary}
        </ButtonLink>
      </div>
      <InlineAlert tone="neutral">{copy.betaNote}</InlineAlert>
    </WebSection>
  );
}
