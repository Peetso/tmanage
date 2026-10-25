'use client';

import Link from '../../WebLink';
import { useState } from 'react';
import { Badge } from '@tmanage/ui';
import { localeDirection } from '../../../../lib/i18n/direction';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { useT } from '../../../../lib/i18n/use-t';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { ButtonLink, SectionHeader, WebIcon, WebSection } from '../..';
import { cx } from '../../primitives';
import {
  PRICING_FAQ,
  PRICING_PLANS,
  planPrice,
  type BillingPeriod,
  type PricingKey,
  type PricingPlan,
} from './pricing-data';
import './pricing.css';

/**
 * The page's catalog lookup. `PricingKey` is `PricingPage.*`; the wave's new keys arrive through
 * the i18n fragment `i18n-A2.*.json`, so the call goes through the typed cast until it is merged.
 */
function usePricingT(): (key: PricingKey, amount?: string) => string {
  const t = useT();
  return (key, amount) => {
    const text = t(key as MessageKey);
    return amount === undefined ? text : text.replace('{amount}', amount);
  };
}

/* ── Hero: the Monthly / Yearly −20% toggle ───────────────────────────────── */

function BillingToggle({
  period,
  onChange,
}: {
  period: BillingPeriod;
  onChange: (next: BillingPeriod) => void;
}) {
  const t = usePricingT();
  const options: readonly { id: BillingPeriod; label: string }[] = [
    { id: 'monthly', label: t('PricingPage.toggleMonthly') },
    { id: 'yearly', label: t('PricingPage.toggleYearlyDiscount') },
  ];
  return (
    <div
      className="tm-segmented tm-pricing-toggle"
      role="group"
      aria-label={t('PricingPage.billingPeriodAria')}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="tm-pricing-toggle__item"
          aria-pressed={period === option.id}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ── Founding offer banner ────────────────────────────────────────────────── */

function FoundingBanner() {
  const t = usePricingT();
  return (
    <aside className="tm-pricing-founding" aria-label={t('PricingPage.foundingBadge')}>
      <Badge mono className="tm-pricing-founding__badge">
        {t('PricingPage.foundingBadge')}
      </Badge>
      <p className="tm-pricing-founding__text">{t('PricingPage.foundingText')}</p>
      <Link href="/contact" className="tm-pricing-founding__cta">
        {t('PricingPage.foundingCta')}
      </Link>
    </aside>
  );
}

/* ── Plan card ────────────────────────────────────────────────────────────── */

function PlanFigure({ plan, period }: { plan: PricingPlan; period: BillingPeriod }) {
  const t = usePricingT();
  if (plan.monthlyCents === null) {
    return (
      <div className="tm-pricing-plan__price">
        <p className="tm-pricing-plan__figure">
          <span className="tm-pricing-plan__amount">{t('PricingPage.customPrice')}</span>
        </p>
        <p className="tm-pricing-plan__note">{t('PricingPage.customNote')}</p>
      </div>
    );
  }
  if (plan.monthlyCents === 0) {
    return (
      <div className="tm-pricing-plan__price">
        <p className="tm-pricing-plan__figure">
          <span className="tm-pricing-plan__amount">$0</span>
          <span className="tm-pricing-plan__unit">{t('PricingPage.unitForever')}</span>
        </p>
        <p className="tm-pricing-plan__note">{t('PricingPage.noCardNeeded')}</p>
      </div>
    );
  }
  const price = planPrice(plan.monthlyCents, period);
  return (
    <div className="tm-pricing-plan__price">
      <p className="tm-pricing-plan__figure">
        <span className="tm-pricing-plan__amount">{price.perMonth}</span>
        <span className="tm-pricing-plan__unit">{t('PricingPage.unitPerMonth')}</span>
      </p>
      {period === 'yearly' ? (
        <>
          <p className="tm-pricing-plan__note">{t('PricingPage.flatPerYear', price.perYear)}</p>
          <p className="tm-pricing-plan__note">{t('PricingPage.ifBilledMonthly', price.monthly)}</p>
        </>
      ) : (
        <>
          <p className="tm-pricing-plan__note">{t('PricingPage.flatWholeTeam')}</p>
          <p className="tm-pricing-plan__note">
            {t('PricingPage.ifBilledYearly', price.yearlyPerMonth)}
          </p>
        </>
      )}
    </div>
  );
}

function PlanCard({ plan, period }: { plan: PricingPlan; period: BillingPeriod }) {
  const t = usePricingT();
  const headingId = `plan-${plan.id}`;
  return (
    <article
      className={cx(
        'tm-pricing-plan',
        plan.featured && 'tm-pricing-plan--featured',
        plan.ink && 'tm-pricing-plan--ink',
      )}
      aria-labelledby={headingId}
    >
      {plan.featured ? (
        <Badge className="tm-pricing-plan__flag">{t('PricingPage.flatFlag')}</Badge>
      ) : null}
      <h3 id={headingId} className="tm-pricing-plan__name">
        {t(plan.nameKey)}
      </h3>
      <p className="tm-pricing-plan__positioning">{t(plan.positioningKey)}</p>
      <PlanFigure plan={plan} period={period} />
      <ButtonLink
        href={plan.cta.href}
        tone={plan.featured || plan.ink ? 'lime' : 'outline'}
        size="feature"
        className="tm-pricing-plan__cta"
      >
        {t(plan.cta.labelKey)}
      </ButtonLink>
      <ul className="tm-pricing-plan__features">
        {plan.featureKeys.map((featureKey) => (
          <li key={featureKey} className="tm-pricing-plan__feature">
            <WebIcon name="check" size={16} className="tm-pricing-plan__check" />
            <span>{t(featureKey)}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export function PricingPage() {
  const t = usePricingT();
  const locale = useActiveLocale();
  const [period, setPeriod] = useState<BillingPeriod>('yearly');

  return (
    <div className="tm-pricing" dir={localeDirection(locale)}>
      <WebSection className="tm-pricing-hero" aria-labelledby="pricing-title">
        <SectionHeader
          as="h1"
          size="page"
          align="center"
          id="pricing-title"
          eyebrow={t('PricingPage.flatEyebrow')}
          title={t('PricingPage.flatTitle')}
          lede={t('PricingPage.flatLede')}
        >
          <div className="tm-pricing-hero__toggle">
            <BillingToggle period={period} onChange={setPeriod} />
            <p className="tm-pricing-hero__note">
              {t(period === 'yearly' ? 'PricingPage.noteYearly' : 'PricingPage.noteMonthly')}
            </p>
          </div>
        </SectionHeader>
        <FoundingBanner />
        <div className="tm-pricing-plans">
          {PRICING_PLANS.map((option) => (
            <PlanCard key={option.id} plan={option} period={period} />
          ))}
        </div>
        <section className="tm-pricing-basecamp" aria-labelledby="pricing-basecamp">
          <div className="tm-pricing-basecamp__text">
            <h2 id="pricing-basecamp" className="tm-pricing-basecamp__title">
              {t('PricingPage.basecampTitle')}
            </h2>
            <p className="tm-pricing-basecamp__body">{t('PricingPage.basecampBody')}</p>
          </div>
          <ButtonLink
            href={SIGN_UP_HREF}
            tone="outline"
            size="default"
            className="tm-pricing-basecamp__cta"
          >
            {t('PricingPage.startFree')}
          </ButtonLink>
        </section>
      </WebSection>

      <WebSection tone="sunken" className="tm-pricing-faq-section" aria-labelledby="pricing-faq">
        <SectionHeader
          id="pricing-faq"
          eyebrow={t('PricingPage.faqEyebrow')}
          title={t('PricingPage.faqFlatTitle')}
          lede={t('PricingPage.faqFlatLede')}
          link={{ label: t('PricingPage.faqFlatLink'), href: '/contact' }}
        />
        <dl className="tm-pricing-faq">
          {PRICING_FAQ.map((item) => (
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
