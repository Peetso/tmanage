'use client';

import { useState } from 'react';
import { Avatar, Badge, Select, StatusDot, VisuallyHidden } from '@tmanage/ui';
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

/* ── Hero with the Monthly / Yearly toggle ────────────────────────────────────── */

function BillingToggle({
  period,
  onChange,
}: {
  period: BillingPeriod;
  onChange: (next: BillingPeriod) => void;
}) {
  const options: readonly { id: BillingPeriod; label: string }[] = [
    { id: 'monthly', label: 'Monthly' },
    { id: 'yearly', label: 'Yearly' },
  ];
  return (
    <div className="tm-segmented tm-pricing-toggle" role="group" aria-label="Billing period">
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
  return (
    <Select
      label="Show plan"
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
        <Badge className="tm-pricing-plan__flag">Most teams start here</Badge>
      ) : null}
      <h3 id={headingId} className="tm-pricing-plan__name">
        {plan.name}
      </h3>
      <p className="tm-pricing-plan__positioning">{plan.positioning}</p>
      <div className="tm-pricing-plan__price">
        <p className="tm-pricing-plan__figure">
          <span className="tm-pricing-plan__amount" aria-label="Price not set yet">
            $ —
          </span>
          <span className="tm-pricing-plan__unit">
            / seat / {period === 'monthly' ? 'mo' : 'yr'}
          </span>
        </p>
        <p className="tm-pricing-plan__note">Launch price at paid beta</p>
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
  return (
    <div className="tm-pricing-rules">
      <article className="tm-pricing-rule">
        <div className="tm-pricing-rule__scene" aria-hidden="true">
          <Avatar name="Peter Adel" decorative className="tm-pricing-rule__avatar" />
          <Avatar name="Mona Kamal" decorative className="tm-pricing-rule__avatar" />
          <Avatar name="Sara Rashed" decorative className="tm-pricing-rule__avatar" />
          <Badge mono>3 seats</Badge>
        </div>
        <h3 className="tm-pricing-rule__title">Internal seats</h3>
        <p className="tm-pricing-rule__body">
          You pay for the people on your team who plan, run and deliver the work. Add or remove
          seats any month.
        </p>
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
        <h3 className="tm-pricing-rule__title">Clients are free</h3>
        <p className="tm-pricing-rule__body">
          Invite every client to their portal. They comment, approve and upload files without using
          a seat.
        </p>
      </article>
      <article className="tm-pricing-rule">
        <div className="tm-pricing-rule__scene tm-pricing-rule__scene--compact" aria-hidden="true">
          <StatusDot tone="success">Counted once</StatusDot>
          <Badge mono>Pooled per workspace</Badge>
        </div>
        <h3 className="tm-pricing-rule__title">Storage is pooled</h3>
        <p className="tm-pricing-rule__body">
          Files count once for the whole workspace, not per seat and not per client.
        </p>
      </article>
    </div>
  );
}

/* ── Comparison table ─────────────────────────────────────────────────────────── */

function Cell({ value }: { value: CompareCell }) {
  if (value === true) {
    return (
      <>
        <WebIcon name="check" size={16} className="tm-pricing-compare__check" />
        <VisuallyHidden>Included</VisuallyHidden>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <span className="tm-pricing-compare__none" aria-hidden="true">
          –
        </span>
        <VisuallyHidden>Not included</VisuallyHidden>
      </>
    );
  }
  return <span className="tm-pricing-compare__word">{value}</span>;
}

function CompareTable({ active }: { active: PlanId }) {
  const on = (id: PlanId) => (id === active ? 'is-active' : undefined);
  return (
    <div className="tm-pricing-compare" role="region" aria-label="Plan comparison">
      <table className="tm-pricing-compare__table">
        <thead>
          <tr>
            <th scope="col" className="tm-pricing-compare__corner">
              Features
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
          eyebrow="Pricing"
          title="Priced per internal seat. Clients are always free."
          lede="Pay only for the people on your team who plan and deliver the work. Clients and their approvers join their portal at no cost, on every plan."
        >
          <div className="tm-pricing-hero__toggle">
            <BillingToggle period={period} onChange={setPeriod} />
            <p className="tm-pricing-hero__note">
              Yearly billing will cost less than twelve monthly payments.
            </p>
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
          eyebrow="How it's counted"
          title="Three rules. No surprises on the invoice."
          lede="Seats are the only thing you pay for. Everything that touches your clients stays free."
        />
        <CountedCards />
      </WebSection>

      <WebSection aria-labelledby="pricing-compare">
        <SectionHeader
          align="center"
          id="pricing-compare"
          eyebrow="Compare plans"
          title="Every plan, side by side."
          lede="See exactly what each plan includes before you choose."
        />
        <PlanPicker plan={plan} onChange={setPlan} className="tm-pricing-picker--compare" />
        <CompareTable active={plan} />
      </WebSection>

      <WebSection tone="sunken" aria-labelledby="pricing-faq">
        <SectionHeader
          id="pricing-faq"
          eyebrow="FAQ"
          title="Questions teams ask before they choose."
          lede="Still unsure? Book a demo and we will walk through your setup with you."
          link={{ label: 'Book a demo', href: '/contact' }}
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
                Bring the next client project into one story.
              </h2>
              <p className="tm-web-cta__lede">
                Start free with your team. Invite your client when the first deliverable is ready.
              </p>
              <div className="tm-web-cta__actions">
                <ButtonLink href="/sign-in" tone="lime" size="default">
                  Start free
                </ButtonLink>
                <ButtonLink href="/contact" tone="outline-ink" size="default">
                  Book a demo
                </ButtonLink>
              </div>
              <p className="tm-web-cta__note">No credit card · Client users are always free</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
