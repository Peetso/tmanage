'use client';

import { StateCapsule } from '@tmanage/ui';
import Link from 'next/link';
import {
  CLAIM_CAPSULE,
  SECURITY_CARDS,
  SECURITY_CLAIMS,
  securityCopy,
} from '../../../../content/security/security-copy';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { languageOf } from '../../../../lib/i18n/route-locale';
import { localizeHref } from '../../../../lib/i18n/public-locale-routes';
import { ButtonLink } from '../../primitives';
import { WebSection } from '../../sections';
import './security-trust.css';

/**
 * Where vulnerability reports go. The support mailbox is the only one that is live today; the
 * copy carries an `{email}` placeholder so a dedicated security@ address can replace this constant
 * later without touching either translation.
 */
export const SECURITY_DISCLOSURE_EMAIL = 'tm-support@peetrix.com';
const EMAIL_PLACEHOLDER = '{email}';

/** The disclosure sentence with the address as a real mailto link, in either language. */
export function DisclosureText({ text, linked = true }: { text: string; linked?: boolean }) {
  const address = linked ? (
    <a href={`mailto:${SECURITY_DISCLOSURE_EMAIL}`} dir="ltr">
      {SECURITY_DISCLOSURE_EMAIL}
    </a>
  ) : (
    <span dir="ltr">{SECURITY_DISCLOSURE_EMAIL}</span>
  );
  const at = text.indexOf(EMAIL_PLACEHOLDER);
  if (at === -1) {
    // A sentence without the placeholder still gets a working address after it.
    return (
      <>
        {text} {address}
      </>
    );
  }
  return (
    <>
      {text.slice(0, at)}
      {address}
      {text.slice(at + EMAIL_PLACEHOLDER.length)}
    </>
  );
}

/**
 * Row 56-20 — security page and trust centre (`/security`, `/ar/security`; Figma 613:34812 /
 * 613:35283, mobile 613:35096 / 613:35539): plain-answer hero, eight cards, the "where we are
 * today" table (live / planned / not audited), sub-processors and security-review cards, and the
 * ink report band. Copy lives in `content/security/security-copy.ts`; each live claim is proven in
 * the lane's SECPAGE-CLAIMS.md.
 */
export function SecurityPage() {
  const language = languageOf(useActiveLocale()) === 'ar' ? 'ar' : 'en';
  const copy = securityCopy(language);
  const href = (path: string) => (language === 'ar' ? localizeHref(path) : path);

  return (
    <div className="tm-trust">
      <WebSection className="tm-trust-hero" spacing="compact" aria-labelledby="security-title">
        <div className="tm-trust-hero__inner">
          <p className="tm-trust-label">{copy.eyebrow}</p>
          <h1 id="security-title" className="tm-trust-hero__title">
            {copy.title}
          </h1>
          <p className="tm-trust-hero__lede">{copy.lede}</p>
          <p className="tm-trust-hero__meta">{copy.meta}</p>
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-trust-body">
        <ul className="tm-trust-cards">
          {SECURITY_CARDS.map((card) => (
            <li key={card} id={card} className="tm-trust-card">
              <h2 className="tm-trust-card__title">{copy.cards[card].title}</h2>
              <p className="tm-trust-card__body">
                {card === 'report' ? (
                  <DisclosureText text={copy.cards[card].body} linked={false} />
                ) : (
                  copy.cards[card].body
                )}
              </p>
            </li>
          ))}
        </ul>

        <section className="tm-trust-today" aria-labelledby="security-today-title">
          <h2 id="security-today-title" className="tm-trust-section-title">
            {copy.todayTitle}
          </h2>
          <p className="tm-trust-today__note">{copy.todayNote}</p>
          <ul className="tm-trust-table">
            {SECURITY_CLAIMS.map((claim) => (
              <li
                key={claim.id}
                className="tm-trust-row"
                data-testid={`security-claim-${claim.id}`}
                data-status={claim.status}
              >
                <span className="tm-trust-row__text">{copy.claims[claim.id]}</span>
                <StateCapsule state={CLAIM_CAPSULE[claim.status]}>
                  {copy.status[claim.status]}
                </StateCapsule>
              </li>
            ))}
          </ul>
        </section>

        <div className="tm-trust-pair">
          <section className="tm-trust-card tm-trust-card--action" id="sub-processors">
            <h2 className="tm-trust-card__title">{copy.subsTitle}</h2>
            <p className="tm-trust-card__body">{copy.subsBody}</p>
            <ButtonLink
              href={href('/security/data-location') + '#subprocessors'}
              tone="outline"
              size="default"
            >
              {copy.subsAction}
            </ButtonLink>
          </section>
          <section className="tm-trust-card tm-trust-card--action">
            <h2 className="tm-trust-card__title">{copy.reviewTitle}</h2>
            <p className="tm-trust-card__body">{copy.reviewBody}</p>
            <ButtonLink href={href('/contact')} tone="outline" size="default">
              {copy.reviewAction}
            </ButtonLink>
          </section>
        </div>
      </WebSection>

      <section className="tm-web-cta-section" aria-labelledby="security-cta-title">
        <div className="tm-web-container">
          <div className="tm-trust-cta">
            <h2 className="tm-trust-cta__title" id="security-cta-title">
              {copy.ctaTitle}
            </h2>
            <p className="tm-trust-cta__body">
              <DisclosureText text={copy.ctaBody} />
            </p>
            <div className="tm-trust-cta__actions">
              <a
                className="tm-button tm-button--lime tm-button--feature tm-web-button"
                href={`mailto:${SECURITY_DISCLOSURE_EMAIL}`}
              >
                {copy.ctaAction}
              </a>
              <Link className="tm-trust-cta__link" href={href('/security/disclosure')}>
                {copy.ctaLink}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
