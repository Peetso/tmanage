'use client';

import { Badge } from '@tmanage/ui';
import { localeDirection } from '../../../../lib/i18n/direction';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { useT } from '../../../../lib/i18n/use-t';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { ButtonLink, SectionHeader, WebIcon, WebSection } from '../..';
import { BETA_FAQ, BETA_INCLUDED, type PricingKey } from './pricing-data';
import './pricing.css';

/**
 * Website `/pricing` and `/ar/pricing` during the public beta — approved Figma 415:23716 (EN) and
 * 418:9605 (AR): one "Everything free during the beta" card, what the beta includes, what happens
 * after it, and the beta FAQ. No billing-period switch, no seat wording and no price comparison;
 * the paid plans stay in `pricing-data.ts` for when pricing is announced.
 */
function usePricingT(): (key: PricingKey) => string {
  const t = useT();
  return (key) => t(key as MessageKey);
}

function BetaCard() {
  const t = usePricingT();
  return (
    <article className="tm-pricing-beta" aria-labelledby="pricing-beta-title">
      <div className="tm-pricing-beta__main">
        <div className="tm-pricing-beta__offer">
          <Badge className="tm-pricing-beta__badge">{t('PricingPage.betaBadge')}</Badge>
          <h2 id="pricing-beta-title" className="tm-pricing-beta__title">
            {t('PricingPage.betaCardTitle')}
          </h2>
          <p className="tm-pricing-beta__figure">
            <span className="tm-pricing-beta__amount">$0</span>
            <span className="tm-pricing-beta__unit">{t('PricingPage.betaUnit')}</span>
          </p>
          <p className="tm-pricing-beta__body">{t('PricingPage.betaCardBody')}</p>
          <ButtonLink href={SIGN_UP_HREF} tone="lime" size="default">
            {t('PricingPage.startFree')}
          </ButtonLink>
          <p className="tm-pricing-beta__micro">{t('PricingPage.betaCardMicro')}</p>
        </div>
        <section className="tm-pricing-beta__included" aria-labelledby="pricing-beta-included">
          <h3 id="pricing-beta-included" className="tm-pricing-beta__included-title">
            {t('PricingPage.betaIncludedTitle')}
          </h3>
          <ul className="tm-pricing-beta__list">
            {BETA_INCLUDED.map((key) => (
              <li key={key} className="tm-pricing-beta__item">
                <WebIcon name="check" size={16} className="tm-pricing-beta__check" />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <p className="tm-pricing-beta__after">
        <span className="tm-pricing-beta__after-label">{t('PricingPage.betaAfterLabel')}</span>
        <span>{t('PricingPage.betaAfterBody')}</span>
      </p>
    </article>
  );
}

export function PricingPage() {
  const t = usePricingT();
  const locale = useActiveLocale();

  return (
    <div className="tm-pricing" dir={localeDirection(locale)}>
      <WebSection className="tm-pricing-hero" aria-labelledby="pricing-title">
        <SectionHeader
          as="h1"
          size="page"
          align="center"
          id="pricing-title"
          eyebrow={t('PricingPage.flatEyebrow')}
          title={t('PricingPage.betaTitle')}
          lede={t('PricingPage.betaLede')}
        />
        <BetaCard />
      </WebSection>

      <WebSection tone="sunken" className="tm-pricing-faq-section" aria-labelledby="pricing-faq">
        <SectionHeader
          id="pricing-faq"
          eyebrow={t('PricingPage.faqEyebrow')}
          title={t('PricingPage.betaFaqTitle')}
          lede={t('PricingPage.betaFaqLede')}
          link={{ label: t('PricingPage.startFree'), href: SIGN_UP_HREF }}
        />
        <dl className="tm-pricing-faq">
          {BETA_FAQ.map((item) => (
            <div key={item.questionKey} className="tm-pricing-faq__item">
              <dt className="tm-pricing-faq__question">{t(item.questionKey)}</dt>
              <dd className="tm-pricing-faq__answer">{t(item.answerKey)}</dd>
            </div>
          ))}
        </dl>
      </WebSection>
    </div>
  );
}
