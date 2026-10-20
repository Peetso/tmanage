'use client';

import { useState } from 'react';
import { Avatar, Badge, Select, StatusDot, VisuallyHidden } from '@tmanage/ui';
import { useT } from '../../../../lib/i18n/use-t';
import { ButtonLink, SectionHeader, WebIcon, WebSection } from '../..';
import { cx } from '../../primitives';
import {
  COMPARE_GROUPS,
  PRICING_FAQ,
  PRICING_PLANS,
  type BillingPeriod,
  type CompareCell,
  type PricingPlan,
} from './pricing-data';
import './pricing.css';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';

/* ── Hero with the Monthly / Yearly toggle ────────────────────────────────────── */

function BillingToggle({
  period,
  onChange,
}: {
  period: BillingPeriod;
  onChange: (next: BillingPeriod) => void;
}) {
  const t = useT();
  const options: readonly { id: BillingPeriod; label: string }[] = [
    { id: 'monthly', label: t('PricingPage.toggleMonthly') },
    { id: 'yearly', label: t('PricingPage.toggleYearly') },
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

/* ── Plan picker — phones and tablets show one plan at a time ─────────────────── */

type PlanId = PricingPlan['id'];

function PlanPicker({
  plan,
  onChange,
  className,
}: {
  plan: PlanId;
  onChange: (next: PlanId) => void;
  className: string;
}) {
  const t = useT();
  return (
    <Select
      label={t('PricingPage.showPlan')}
      className={cx('tm-pricing-picker', className)}
      value={plan}
      onChange={(event) => onChange(event.target.value as PlanId)}
    >
      {PRICING_PLANS.map((option) => (
        <option key={option.id} value={option.id}>
          {option.name}
        </option>
      ))}
    </Select>
  );
}

/* ── Plan card ────────────────────────────────────────────────────────────────── */

function PlanCard({
  plan,
  period,
  active,
}: {
  plan: PricingPlan;
  period: BillingPeriod;
  active: boolean;
}) {
  const t = useT();
  const headingId = `plan-${plan.id}`;
  return (
    <article
      className={cx(
        'tm-pricing-plan',
        plan.featured && 'tm-pricing-plan--featured',
        plan.ink && 'tm-pricing-plan--ink',
        active && 'is-active',
      )}
      aria-labelledby={headingId}
    >
      {plan.featured ? (
        <Badge className="tm-pricing-plan__flag">{t('PricingPage.planFlag')}</Badge>
      ) : null}
      <h3 id={headingId} className="tm-pricing-plan__name">
        {plan.name}
      </h3>
      <p className="tm-pricing-plan__positioning">{plan.positioning}</p>
      <div className="tm-pricing-plan__price">
        <p className="tm-pricing-plan__figure">
          <span className="tm-pricing-plan__amount" aria-label={t('PricingPage.priceAria')}>
            $ —
          </span>
          <span className="tm-pricing-plan__unit">
            / {t('PricingPage.seatWord')} /{' '}
            {period === 'monthly' ? t('PricingPage.moWord') : t('PricingPage.yrWord')}
          </span>
        </p>
        <p className="tm-pricing-plan__note">{t('PricingPage.launchNote')}</p>
      </div>
      <ButtonLink
        href={plan.cta.href}
        tone={plan.featured || plan.ink ? 'lime' : 'outline'}
        size="feature"
        className="tm-pricing-plan__cta"
      >
        {plan.cta.label}
      </ButtonLink>
      <ul className="tm-pricing-plan__features">
        {plan.features.map((feature) => (
          <li key={feature} className="tm-pricing-plan__feature">
            <WebIcon name="check" size={16} className="tm-pricing-plan__check" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/* ── "How it's counted" — three mini product scenes ──────────────────────────── */

function CountedCards() {
  const t = useT();
  return (
    <div className="tm-pricing-rules">
      <article className="tm-pricing-rule">
        <div className="tm-pricing-rule__scene" aria-hidden="true">
          <Avatar name="Peter Adel" decorative className="tm-pricing-rule__avatar" />
          <Avatar name="Mona Kamal" decorative className="tm-pricing-rule__avatar" />
          <Avatar name="Sara Rashed" decorative className="tm-pricing-rule__avatar" />
          <Badge mono>3 seats</Badge>
        </div>
        <h3 className="tm-pricing-rule__title">{t('PricingPage.ruleSeatsTitle')}</h3>
        <p className="tm-pricing-rule__body">{t('PricingPage.ruleSeatsBody')}</p>
      </article>
      <article className="tm-pricing-rule">
        <div className="tm-pricing-rule__scene" aria-hidden="true">
          <Avatar name="Nadia Victor" audience="client" decorative />
          <Avatar name="Laila Hosny" audience="client" decorative />
          <Badge tone="client">
            <span className="tm-pricing-rule__mono">Portal</span>
            <span className="tm-pricing-rule__ink">Free, always</span>
          </Badge>
        </div>
        <h3 className="tm-pricing-rule__title">{t('PricingPage.ruleClientsTitle')}</h3>
        <p className="tm-pricing-rule__body">{t('PricingPage.ruleClientsBody')}</p>
      </article>
      <article className="tm-pricing-rule">
        <div className="tm-pricing-rule__scene tm-pricing-rule__scene--compact" aria-hidden="true">
          <StatusDot tone="success">Counted once</StatusDot>
          <Badge mono>Pooled per workspace</Badge>
        </div>
        <h3 className="tm-pricing-rule__title">{t('PricingPage.ruleStorageTitle')}</h3>
        <p className="tm-pricing-rule__body">{t('PricingPage.ruleStorageBody')}</p>
      </article>
    </div>
  );
}

/* ── Comparison table ─────────────────────────────────────────────────────────── */

function Cell({ value }: { value: CompareCell }) {
  const t = useT();
  if (value === true) {
    return (
      <>
        <WebIcon name="check" size={16} className="tm-pricing-compare__check" />
        <VisuallyHidden>{t('PricingPage.cellIncluded')}</VisuallyHidden>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <span className="tm-pricing-compare__none" aria-hidden="true">
          –
        </span>
        <VisuallyHidden>{t('PricingPage.cellNotIncluded')}</VisuallyHidden>
      </>
    );
  }
  return <span className="tm-pricing-compare__word">{value}</span>;
}

function CompareTable({ active }: { active: PlanId }) {
  const t = useT();
  const on = (id: PlanId) => (id === active ? 'is-active' : undefined);
  return (
    <div className="tm-pricing-compare" role="region" aria-label={t('PricingPage.compareAria')}>
      <table className="tm-pricing-compare__table">
        <thead>
          <tr>
            <th scope="col" className="tm-pricing-compare__corner">
              {t('PricingPage.compareFeatures')}
            </th>
            {PRICING_PLANS.map((plan) => (
              <th key={plan.id} scope="col" className={cx('tm-pricing-compare__plan', on(plan.id))}>
                {plan.name}
              </th>
            ))}
          </tr>
        </thead>
        {COMPARE_GROUPS.map((group) => (
          <tbody key={group.category}>
            <tr className="tm-pricing-compare__group">
              <th scope="colgroup" colSpan={PRICING_PLANS.length + 1}>
                {group.category}
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.feature}>
                <th scope="row" className="tm-pricing-compare__feature">
                  {row.feature}
                </th>
                {row.cells.map((cell, i) => (
                  <td
                    key={PRICING_PLANS[i]?.id ?? i}
                    className={cx(
                      'tm-pricing-compare__cell',
                      PRICING_PLANS[i] && on(PRICING_PLANS[i].id),
                    )}
                  >
                    <Cell value={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/* ── Page ─────────────────────────────────────────────────────────────────────── */

export function PricingPage() {
  const t = useT();
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [plan, setPlan] = useState<PlanId>('studio');

  return (
    <div className="tm-pricing">
      <WebSection className="tm-pricing-hero" aria-labelledby="pricing-title">
        <SectionHeader
          as="h1"
          size="page"
          align="center"
          id="pricing-title"
          eyebrow={t('PricingPage.heroEyebrow')}
          title={t('PricingPage.heroTitle')}
          lede={t('PricingPage.heroLede')}
        >
          <div className="tm-pricing-hero__toggle">
            <BillingToggle period={period} onChange={setPeriod} />
            <p className="tm-pricing-hero__note">{t('PricingPage.heroNote')}</p>
          </div>
        </SectionHeader>
        <PlanPicker plan={plan} onChange={setPlan} className="tm-pricing-picker--plans" />
        <div className="tm-pricing-plans">
          {PRICING_PLANS.map((option) => (
            <PlanCard key={option.id} plan={option} period={period} active={option.id === plan} />
          ))}
        </div>
      </WebSection>

      <WebSection tone="sunken" className="tm-pricing-counted" aria-labelledby="pricing-counted">
        <SectionHeader
          align="center"
          id="pricing-counted"
          eyebrow={t('PricingPage.countedEyebrow')}
          title={t('PricingPage.countedTitle')}
          lede={t('PricingPage.countedLede')}
        />
        <CountedCards />
      </WebSection>

      <WebSection aria-labelledby="pricing-compare">
        <SectionHeader
          align="center"
          id="pricing-compare"
          eyebrow={t('PricingPage.compareEyebrow')}
          title={t('PricingPage.compareTitle')}
          lede={t('PricingPage.compareLede')}
        />
        <PlanPicker plan={plan} onChange={setPlan} className="tm-pricing-picker--compare" />
        <CompareTable active={plan} />
      </WebSection>

      <WebSection tone="sunken" aria-labelledby="pricing-faq">
        <SectionHeader
          id="pricing-faq"
          eyebrow={t('PricingPage.faqEyebrow')}
          title={t('PricingPage.faqTitle')}
          lede={t('PricingPage.faqLede')}
          link={{ label: t('PricingPage.faqLink'), href: '/contact' }}
        />
        <dl className="tm-pricing-faq">
          {PRICING_FAQ.map((item) => (
            <div key={item.question} className="tm-pricing-faq__item">
              <dt className="tm-pricing-faq__question">{item.question}</dt>
              <dd className="tm-pricing-faq__answer">{item.answer}</dd>
            </div>
          ))}
        </dl>
      </WebSection>

      <section className="tm-web-cta-section" aria-labelledby="pricing-cta">
        <div className="tm-web-container">
          <div className="tm-web-cta tm-web-cta--text tm-pricing-cta">
            <div className="tm-web-cta__text">
              <h2 id="pricing-cta" className="tm-web-cta__title">
                {t('PricingPage.ctaTitle')}
              </h2>
              <p className="tm-web-cta__lede">{t('PricingPage.ctaLede')}</p>
              <div className="tm-web-cta__actions">
                <ButtonLink href={SIGN_UP_HREF} tone="lime" size="default">
                  {t('PricingPage.startFree')}
                </ButtonLink>
                <ButtonLink href="/contact" tone="outline-ink" size="default">
                  {t('PricingPage.bookDemo')}
                </ButtonLink>
              </div>
              <p className="tm-web-cta__note">{t('PricingPage.ctaNote')}</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
