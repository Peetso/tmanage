'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { BetaBillingPanel, useBetaBillingHeading } from '../billing/BetaBillingPanel';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchSubscription, requestPlanChange } from '../../lib/api/subscription';
import type { SubscriptionView } from '../../lib/api/subscription';
import { useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { formatUsd, planPrice } from '../website/pages/pricing/pricing-data';
import type { BillingPeriod } from '../website/pages/pricing/pricing-data';
import './subscription-plans.css';
import { appDateLocale } from '../../lib/i18n/app-locale';

export interface SubscriptionScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Choose a plan** — the in-app plan picker (approved Figma 376:17695 task 12, frames 379:4075 EN /
 * 379:4380 AR). Five flat plans for the whole team, never per member: Free, Starter, Studio,
 * Business, Enterprise. The current plan carries the "Current plan" pill and the ink border; a
 * cheaper plan offers "Switch to …", a dearer one "Upgrade", Enterprise "Contact sales". The info
 * row under the cards reads the API's people count and next bill date.
 *
 * Both routes sit behind `org.manage`. A switch records an intent (`pending_change`) — no payment is
 * executed here.
 */

type PlanId = 'free' | 'starter' | 'studio' | 'business' | 'enterprise';

interface PlanCard {
  readonly id: PlanId;
  readonly name: readonly [key: string, english: string];
  /** Flat monthly price for the whole team in US cents; `null` is Enterprise (custom). */
  readonly monthlyCents: number | null;
  readonly features: readonly (readonly [key: string, english: string])[];
}

const K = 'SubscriptionScreen.plans.';

const PLANS: readonly PlanCard[] = [
  {
    id: 'free',
    name: [`${K}freeName`, 'Free'],
    monthlyCents: 0,
    features: [
      [`${K}freeFeature1`, 'Up to 3 internal people'],
      [`${K}freeFeature2`, '3 active projects'],
      [`${K}freeFeature3`, 'Unlimited clients, always free'],
      [`${K}freeFeature4`, 'Work, chat and calendar'],
    ],
  },
  {
    id: 'starter',
    name: [`${K}starterName`, 'Starter'],
    monthlyCents: 1900,
    features: [
      [`${K}starterFeature1`, 'Up to 10 internal people'],
      [`${K}starterFeature2`, 'Unlimited projects'],
      [`${K}starterFeature3`, 'Requests and approvals'],
      [`${K}starterFeature4`, 'Branded client portal'],
    ],
  },
  {
    id: 'studio',
    name: [`${K}studioName`, 'Studio'],
    monthlyCents: 4900,
    features: [
      [`${K}studioFeature1`, 'Unlimited internal people'],
      [`${K}studioFeature2`, 'Docs and decisions'],
      [`${K}studioFeature3`, 'Workload insights'],
      [`${K}studioFeature4`, 'Automations'],
    ],
  },
  {
    id: 'business',
    name: [`${K}businessName`, 'Business'],
    monthlyCents: 8900,
    features: [
      [`${K}businessFeature1`, 'Unlimited internal people'],
      [`${K}businessFeature2`, 'IP allowlist and session controls'],
      [`${K}businessFeature3`, 'Admin console and roles'],
      [`${K}businessFeature4`, 'Audit log and priority support'],
    ],
  },
  {
    id: 'enterprise',
    name: [`${K}enterpriseName`, 'Enterprise'],
    monthlyCents: null,
    features: [
      [`${K}enterpriseFeature1`, 'Everything in Business'],
      [`${K}enterpriseFeature3`, 'Contracts and invoicing'],
      [`${K}enterpriseFeature4`, 'Named success lead'],
    ],
  },
];

const RANK: Readonly<Record<PlanId, number>> = {
  free: 0,
  starter: 1,
  studio: 2,
  business: 3,
  enterprise: 4,
};

/** A stored plan id read as a catalog plan: the API already maps `pro` to `studio`. */
function asPlanId(planId: string): PlanId {
  if (planId === 'pro') return 'studio';
  return planId in RANK ? (planId as PlanId) : 'free';
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

export function SubscriptionScreen({
  organizationSlug,
  organizationName,
  client,
}: SubscriptionScreenProps) {
  const describe = useDescribeApiError();
  const t = useT();
  const tOr = useTOr();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const subscriptionKey = ['organization-subscription', organizationSlug];
  const [period, setPeriod] = useState<BillingPeriod>('monthly');

  const subscription = useQuery({
    queryKey: subscriptionKey,
    queryFn: () => fetchSubscription(api, organizationSlug),
  });

  // The public beta (BILLING_MODE=beta_free, the API's default): no plan to pick, nothing to buy.
  const beta = subscription.data?.billingMode !== 'paid';
  const betaHeading = useBetaBillingHeading(organizationSlug, organizationName);

  const change = useMutation({
    mutationFn: (planId: PlanId) => requestPlanChange(api, organizationSlug, planId),
    onSuccess: (view) => {
      queryClient.setQueryData(subscriptionKey, view);
    },
  });

  const tabs = (
    <div className="tm-plans-tabs" role="group" aria-label={tOr(`${K}periodLabel`, 'Billing')}>
      {(['monthly', 'yearly'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className="tm-plans-tabs__tab"
          aria-pressed={period === value}
          onClick={() => setPeriod(value)}
        >
          {value === 'monthly'
            ? tOr(`${K}monthly`, 'Monthly')
            : tOr(`${K}yearly`, 'Yearly · save 20%')}
        </button>
      ))}
    </div>
  );

  return (
    <SettingsShell
      section="billing"
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      title={beta ? betaHeading.title : tOr(`${K}title`, 'Choose a plan')}
      description={
        beta
          ? betaHeading.description
          : tOr(
              `${K}subtitle`,
              'Flat prices for your whole team, not per member. Clients are always free and never count as people.',
            )
      }
      actions={beta ? undefined : tabs}
    >
      <div className="tm-plans">
        {subscription.isPending ? (
          <LoadingRegion label={t('SubscriptionScreen.loading')} className="tm-plans__grid">
            {PLANS.map((plan) => (
              <Skeleton key={plan.id} height="var(--s24)" />
            ))}
          </LoadingRegion>
        ) : null}

        {subscription.isError ? (
          <InlineAlert tone="danger" title={t('SubscriptionScreen.loadError')} live>
            {describe(subscription.error)}
          </InlineAlert>
        ) : null}

        {subscription.isSuccess && beta ? (
          <BetaBillingPanel internalPeople={subscription.data.internalPeopleCount} />
        ) : null}

        {subscription.isSuccess && !beta ? (
          <PlanPicker
            organizationSlug={organizationSlug}
            subscription={subscription.data}
            period={period}
            onSwitch={(planId) => change.mutate(planId)}
            pendingPlan={change.isPending ? (change.variables ?? null) : null}
            changeError={change.isError ? describe(change.error) : null}
            changed={change.isSuccess ? asPlanId(change.data.planId) : null}
          />
        ) : null}
      </div>
    </SettingsShell>
  );
}

function PlanPicker({
  organizationSlug,
  subscription,
  period,
  onSwitch,
  pendingPlan,
  changeError,
  changed,
}: {
  organizationSlug: string;
  subscription: SubscriptionView;
  period: BillingPeriod;
  onSwitch: (planId: PlanId) => void;
  pendingPlan: PlanId | null;
  changeError: string | null;
  changed: PlanId | null;
}) {
  const tOr = useTOr();
  const locale = useActiveLocale();
  const current = asPlanId(subscription.planId);
  const nameOf = (id: PlanId): string => {
    const plan = PLANS.find((p) => p.id === id) ?? PLANS[0]!;
    return tOr(...plan.name);
  };

  return (
    <>
      <ul className="tm-plans__grid" aria-label={tOr(`${K}title`, 'Choose a plan')}>
        {PLANS.map((plan) => {
          const isCurrent = plan.id === current;
          const name = tOr(...plan.name);
          return (
            <li
              key={plan.id}
              className="tm-plans-card"
              data-plan={plan.id}
              data-current={isCurrent || undefined}
              aria-current={isCurrent || undefined}
            >
              <div className="tm-plans-card__head">
                <h2 className="tm-plans-card__name">{name}</h2>
                {isCurrent ? (
                  <span className="tm-plans-card__pill">
                    {tOr(`${K}currentPlan`, 'Current plan')}
                  </span>
                ) : null}
              </div>

              <PriceLine plan={plan} period={period} />

              <ul className="tm-plans-card__features">
                {plan.features.map(([key, english]) => (
                  <li key={key} className="tm-plans-card__feature">
                    <span className="tm-plans-card__check" aria-hidden="true">
                      ✓
                    </span>
                    <span>{tOr(key, english)}</span>
                  </li>
                ))}
              </ul>

              <div className="tm-plans-card__action">
                {plan.id === 'enterprise' ? (
                  <Link
                    href="/contact"
                    className="tm-button tm-button--outline tm-button--default tm-plans-card__button"
                  >
                    {tOr(`${K}contactSales`, 'Contact sales')}
                  </Link>
                ) : isCurrent ? (
                  <Link
                    href={`/${encodeURIComponent(organizationSlug)}/billing/plan-change/request`}
                    className="tm-button tm-button--outline tm-button--default tm-plans-card__button"
                  >
                    {tOr(`${K}managePlan`, 'Manage plan')}
                  </Link>
                ) : RANK[plan.id] > RANK[current] ? (
                  <Button
                    tone="ink"
                    className="tm-plans-card__button"
                    loading={pendingPlan === plan.id}
                    loadingLabel={tOr(`${K}switching`, 'Switching plan')}
                    disabled={pendingPlan !== null && pendingPlan !== plan.id}
                    onClick={() => onSwitch(plan.id)}
                  >
                    {fill(tOr(`${K}upgrade`, 'Upgrade'), { plan: name })}
                  </Button>
                ) : (
                  <Button
                    tone="outline"
                    className="tm-plans-card__button"
                    loading={pendingPlan === plan.id}
                    loadingLabel={tOr(`${K}switching`, 'Switching plan')}
                    disabled={pendingPlan !== null && pendingPlan !== plan.id}
                    onClick={() => onSwitch(plan.id)}
                  >
                    {fill(tOr(`${K}switchTo`, 'Switch to {plan}'), { plan: name })}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {changeError !== null ? (
        <InlineAlert tone="danger" title={tOr(`${K}changeError`, 'Could not switch the plan')} live>
          {changeError}
        </InlineAlert>
      ) : null}

      {changed !== null ? (
        <InlineAlert tone="success" title={tOr(`${K}changedTitle`, 'Plan change recorded')} live>
          {fill(
            tOr(`${K}changedBody`, 'We recorded your move to {plan}. Nothing has been charged.'),
            {
              plan: nameOf(changed),
            },
          )}
        </InlineAlert>
      ) : null}

      <p className="tm-plans-info">
        <span className="tm-plans-info__glyph" aria-hidden="true">
          i
        </span>
        <span>{infoLine(subscription, current, nameOf(current), locale, tOr)}</span>
      </p>
    </>
  );
}

function PriceLine({ plan, period }: { plan: PlanCard; period: BillingPeriod }) {
  const tOr = useTOr();
  if (plan.monthlyCents === null) {
    return (
      <div className="tm-plans-card__price tm-plans-card__price--custom">
        <span className="tm-plans-card__amount">{tOr(`${K}custom`, 'Custom')}</span>
        <span className="tm-plans-card__per">{tOr(`${K}contactUs`, 'contact us')}</span>
      </div>
    );
  }
  if (plan.monthlyCents === 0) {
    return (
      <div className="tm-plans-card__price">
        <span className="tm-plans-card__amount">{formatUsd(0)}</span>
        <span className="tm-plans-card__per">{tOr(`${K}forever`, 'forever')}</span>
      </div>
    );
  }
  return (
    <div className="tm-plans-card__price">
      <span className="tm-plans-card__amount">{planPrice(plan.monthlyCents, period).perMonth}</span>
      <span className="tm-plans-card__per">
        {period === 'yearly'
          ? tOr(`${K}perMonthYearly`, 'a month, billed yearly')
          : tOr(`${K}perMonthFlat`, 'a month, flat')}
      </span>
    </div>
  );
}

function infoLine(
  subscription: SubscriptionView,
  current: PlanId,
  planName: string,
  locale: string,
  tOr: (key: string, english: string) => string,
): string {
  const count = String(subscription.internalPeopleCount);
  if (current === 'free') {
    return fill(
      tOr(
        `${K}infoFree`,
        'You have {count} internal people on {plan}: $0, forever. Clients are always free.',
      ),
      { count, plan: planName },
    );
  }
  if (current === 'enterprise') {
    return fill(
      tOr(`${K}infoCustom`, 'You have {count} internal people on {plan}, priced by your contract.'),
      { count, plan: planName },
    );
  }
  const cents = PLANS.find((p) => p.id === current)?.monthlyCents ?? 0;
  return fill(
    tOr(
      `${K}infoPaid`,
      'You have {count} internal people on {plan}: {price} a month, flat. Next bill on {date}. Yearly billing saves 20 %.',
    ),
    {
      count,
      plan: planName,
      price: formatUsd(cents),
      amount: (cents / 100).toFixed(Number.isInteger(cents / 100) ? 0 : 2),
      date: subscription.nextBillAt === null ? '' : formatBillDate(subscription.nextBillAt, locale),
    },
  );
}

/** "1 November" in English, "1 نوفمبر" in Arabic (Latin digits, as drawn). UTC, like the API. */
function formatBillDate(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const tag = appDateLocale(locale.startsWith('ar') ? locale : 'en-GB');
  return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    at,
  );
}
