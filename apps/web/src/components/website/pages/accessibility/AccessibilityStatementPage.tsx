'use client';

import { StateCapsule } from '@tmanage/ui';
import Link from 'next/link';
import {
  A11Y_CAPSULE,
  A11Y_CARDS,
  A11Y_CLAIMS,
  ACCESSIBILITY_FEEDBACK_EMAIL,
  accessibilityCopy,
} from '../../../../content/accessibility/accessibility-copy';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { languageOf } from '../../../../lib/i18n/route-locale';
import { localizeHref } from '../../../../lib/i18n/public-locale-routes';
import { ButtonLink } from '../../primitives';
import { WebSection } from '../../sections';
import '../security/security-trust.css';

const EMAIL_PLACEHOLDER = '{email}';

/** A copy line with the feedback address in place of `{email}`, as a mailto link or plain text. */
function FeedbackText({ text, linked = true }: { text: string; linked?: boolean }) {
  const [before, after = ''] = text.split(EMAIL_PLACEHOLDER);
  return (
    <>
      {before}
      {linked ? (
        <a href={`mailto:${ACCESSIBILITY_FEEDBACK_EMAIL}`} dir="ltr">
          {ACCESSIBILITY_FEEDBACK_EMAIL}
        </a>
      ) : (
        <span dir="ltr">{ACCESSIBILITY_FEEDBACK_EMAIL}</span>
      )}
      {after}
    </>
  );
}

/**
 * The public accessibility statement (`/accessibility`, `/ar/accessibility`). No Figma frame of
 * its own exists, so it is drawn in the security trust centre's layout and classes: plain-answer
 * hero, eight cards, the "where we are today" table, a known-gaps card beside an ask-us card, and
 * the ink feedback band. Copy lives in `content/accessibility/accessibility-copy.ts`.
 */
export function AccessibilityStatementPage() {
  const language = languageOf(useActiveLocale()) === 'ar' ? 'ar' : 'en';
  const copy = accessibilityCopy(language);
  const href = (path: string) => (language === 'ar' ? localizeHref(path) : path);

  return (
    <div className="tm-trust">
      <WebSection className="tm-trust-hero" spacing="compact" aria-labelledby="accessibility-title">
        <div className="tm-trust-hero__inner">
          <p className="tm-trust-label">{copy.eyebrow}</p>
          <h1 id="accessibility-title" className="tm-trust-hero__title">
            {copy.title}
          </h1>
          <p className="tm-trust-hero__lede">{copy.lede}</p>
          <p className="tm-trust-hero__meta">{copy.meta}</p>
        </div>
      </WebSection>

      <WebSection spacing="flush" className="tm-trust-body">
        <ul className="tm-trust-cards">
          {A11Y_CARDS.map((card) => (
            <li key={card} id={card} className="tm-trust-card">
              <h2 className="tm-trust-card__title">{copy.cards[card].title}</h2>
              <p className="tm-trust-card__body">
                {card === 'feedback' ? (
                  <FeedbackText text={copy.cards[card].body} linked={false} />
                ) : (
                  copy.cards[card].body
                )}
              </p>
            </li>
          ))}
        </ul>

        <section className="tm-trust-today" aria-labelledby="accessibility-today-title">
          <h2 id="accessibility-today-title" className="tm-trust-section-title">
            {copy.todayTitle}
          </h2>
          <p className="tm-trust-today__note">{copy.todayNote}</p>
          <ul className="tm-trust-table">
            {A11Y_CLAIMS.map((claim) => (
              <li
                key={claim.id}
                className="tm-trust-row"
                data-testid={`a11y-claim-${claim.id}`}
                data-status={claim.status}
              >
                <span className="tm-trust-row__text">{copy.claims[claim.id]}</span>
                <StateCapsule state={A11Y_CAPSULE[claim.status]}>
                  {copy.status[claim.status]}
                </StateCapsule>
              </li>
            ))}
          </ul>
        </section>

        <div className="tm-trust-pair">
          <section className="tm-trust-card" id="known-gaps" aria-labelledby="known-gaps-title">
            <h2 id="known-gaps-title" className="tm-trust-card__title">
              {copy.gapsTitle}
            </h2>
            <p className="tm-trust-card__body">{copy.gapsBody}</p>
          </section>
          <section className="tm-trust-card tm-trust-card--action">
            <h2 className="tm-trust-card__title">{copy.helpTitle}</h2>
            <p className="tm-trust-card__body">{copy.helpBody}</p>
            <ButtonLink href={href('/contact')} tone="outline" size="default">
              {copy.helpAction}
            </ButtonLink>
          </section>
        </div>
      </WebSection>

      <section className="tm-web-cta-section" aria-labelledby="accessibility-cta-title">
        <div className="tm-web-container">
          <div className="tm-trust-cta">
            <h2 className="tm-trust-cta__title" id="accessibility-cta-title">
              {copy.ctaTitle}
            </h2>
            <p className="tm-trust-cta__body">
              <FeedbackText text={copy.ctaBody} />
            </p>
            <div className="tm-trust-cta__actions">
              <a
                className="tm-button tm-button--lime tm-button--feature tm-web-button"
                href={`mailto:${ACCESSIBILITY_FEEDBACK_EMAIL}`}
              >
                {copy.ctaAction}
              </a>
              <Link className="tm-trust-cta__link" href={href('/security')}>
                {copy.ctaLink}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
