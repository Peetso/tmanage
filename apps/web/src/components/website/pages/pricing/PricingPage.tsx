'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@tmanage/ui';
import { browserApiClient } from '../../../../lib/api/browser-client';
import type { ApiClient } from '../../../../lib/api/client';
import { fetchPublishedPlans } from '../../../../lib/api/plan-versions';
import type { PublishedPlanView, PublishedPlansView } from '../../../../lib/api/plan-versions';
import { localeDirection } from '../../../../lib/i18n/direction';
import type { MessageKey } from '../../../../lib/i18n/t';
import { useActiveLocale } from '../../../../lib/i18n/use-active-locale';
import { useT } from '../../../../lib/i18n/use-t';
import { useTOr } from '../../../../lib/i18n/use-t-or';
import { SIGN_UP_HREF } from '../../../../lib/public-signup';
import { ButtonLink, SectionHeader, WebIcon, WebSection } from '../..';
import {
  BETA_FAQ,
  BETA_INCLUDED,
  PRICING_FAQ,
  PRICING_PLANS,
  formatUsd,
  type PricingKey,
  type PricingLimitLine,
  type PricingPlan,
} from './pricing-data';
import './pricing.css';

/**
 * Website `/pricing` and `/ar/pricing`.
 *
 * - **Public beta** (approved Figma 415:23716 EN / 418:9605 AR): one "Everything free during the
 *   beta" card, what the beta includes, what happens after it, and the beta FAQ. No price but $0,
 *   no plan to choose. This is also what renders first and whenever the live ladder cannot be read.
 * - **Paid** (approved Figma 376:2087, pr-desktop / pr-mobile; PLANWEB): one card per plan, every
 *   price and limit figure read live from `GET /v1/public/plan-versions` (the version of each plan
 *   in force now). The API answers `visible: false` while `beta_free` is on, so no figure can leak
 *   during the beta. A plan's call to action carries only its id to sign-up (`?plan=`); the API
 *   checks it again and never takes a price from it.
 */
function usePricingT(): (key: PricingKey) => string {
  const t = useT();
  return (key) => t(key as MessageKey);
}

/** The live ladder, or `null` until (or unless) the API says plans may be shown. */
function usePublishedPlans(client: ApiClient | undefined): PublishedPlansView | null {
  const [view, setView] = useState<PublishedPlansView | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const answer = await fetchPublishedPlans(client ?? browserApiClient());
        if (!cancelled) setView(answer);
      } catch {
        // Unreadable: the page stays on the beta card, which promises nothing it cannot keep.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);
  return view;
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

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** A limit bullet from the live version: its own figure, or the catalog's "unlimited" line. */
function useLimitLine(): (line: PricingLimitLine, live: PublishedPlanView) => string {
  const t = usePricingT();
  const tOr = useTOr();
  return (line, live) => {
    if (line === 'limit:people') {
      return live.limits.people === null
        ? t('PricingPage.flatStudioFeature1')
        : fill(tOr('PricingPage.livePeople', 'Up to {count} internal people'), {
            count: String(live.limits.people),
          });
    }
    return live.limits.activeProjects === null
      ? t('PricingPage.flatStarterFeature2')
      : fill(tOr('PricingPage.liveProjects', '{count} active projects'), {
          count: String(live.limits.activeProjects),
        });
  };
}

function PlanCard({ plan, live }: { plan: PricingPlan; live: PublishedPlanView }) {
  const t = usePricingT();
  const limitLine = useLimitLine();
  const featured = plan.featured === true;
  const ink = plan.ink === true;
  const custom = live.monthlyCents === null;
  // The CTA carries the plan id only; Enterprise (quoted per contract) goes to contact.
  const href = custom ? plan.cta.href : `${plan.cta.href}?plan=${encodeURIComponent(live.planId)}`;
  const className = [
    'tm-pricing-plan',
    featured ? 'tm-pricing-plan--featured' : '',
    ink ? 'tm-pricing-plan--ink' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <article className={className} aria-labelledby={`pricing-plan-${plan.id}`}>
      {featured ? (
        <Badge className="tm-pricing-plan__flag">{t('PricingPage.flatFlag')}</Badge>
      ) : null}
      <h2 id={`pricing-plan-${plan.id}`} className="tm-pricing-plan__name">
        {t(plan.nameKey)}
      </h2>
      <p className="tm-pricing-plan__positioning">{t(plan.positioningKey)}</p>
      <div className="tm-pricing-plan__price">
        <p className="tm-pricing-plan__figure">
          <span className="tm-pricing-plan__amount">
            {live.monthlyCents === null
              ? t('PricingPage.customPrice')
              : formatUsd(live.monthlyCents)}
          </span>
          {live.monthlyCents === null ? null : (
            <span className="tm-pricing-plan__unit">{t('PricingPage.unitPerMonth')}</span>
          )}
        </p>
        <p className="tm-pricing-plan__note">
          {live.monthlyCents === null
            ? t('PricingPage.customNote')
            : live.yearlyCents !== null && live.yearlyCents > 0
              ? fill(t('PricingPage.flatPerYear'), {
                  amount: formatUsd(live.yearlyCents, 'always'),
                })
              : t('PricingPage.flatWholeTeam')}
        </p>
      </div>
      <ButtonLink
        href={href}
        tone={featured ? 'lime' : ink ? 'outline-ink' : 'outline'}
        size="default"
        className="tm-pricing-plan__cta"
      >
        {t(plan.cta.labelKey)}
      </ButtonLink>
      <ul className="tm-pricing-plan__features">
        {plan.featureKeys.map((key) => (
          <li key={key} className="tm-pricing-plan__feature">
            <WebIcon name="check" size={16} className="tm-pricing-plan__check" />
            <span>
              {key === 'limit:people' || key === 'limit:projects' ? limitLine(key, live) : t(key)}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function PaidPlans({ plans }: { plans: readonly PublishedPlanView[] }) {
  const byId = new Map(plans.map((live) => [live.planId, live]));
  return (
    <div className="tm-pricing-plans">
      {PRICING_PLANS.map((plan) => {
        const live = byId.get(plan.id);
        return live === undefined ? null : <PlanCard key={plan.id} plan={plan} live={live} />;
      })}
    </div>
  );
}

export interface PricingPageProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

export function PricingPage({ client }: PricingPageProps = {}) {
  const t = usePricingT();
  const locale = useActiveLocale();
  const published = usePublishedPlans(client);
  const paid = published !== null && published.visible && published.plans.length > 0;
  const faq = paid ? PRICING_FAQ : BETA_FAQ;

  return (
    <div className="tm-pricing" dir={localeDirection(locale)}>
      <WebSection className="tm-pricing-hero" aria-labelledby="pricing-title">
        <SectionHeader
          as="h1"
          size="page"
          align="center"
          id="pricing-title"
          eyebrow={t('PricingPage.flatEyebrow')}
          title={paid ? t('PricingPage.flatTitle') : t('PricingPage.betaTitle')}
          lede={paid ? t('PricingPage.flatLede') : t('PricingPage.betaLede')}
        />
        {paid ? <PaidPlans plans={published.plans} /> : <BetaCard />}
      </WebSection>

      <WebSection tone="sunken" className="tm-pricing-faq-section" aria-labelledby="pricing-faq">
        <SectionHeader
          id="pricing-faq"
          eyebrow={t('PricingPage.faqEyebrow')}
          title={paid ? t('PricingPage.faqTitle') : t('PricingPage.betaFaqTitle')}
          lede={paid ? t('PricingPage.faqLede') : t('PricingPage.betaFaqLede')}
          link={{ label: t('PricingPage.startFree'), href: SIGN_UP_HREF }}
        />
        <dl className="tm-pricing-faq">
          {faq.map((item) => (
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
