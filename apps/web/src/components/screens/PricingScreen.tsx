'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LiveAnnouncer, LoadingRegion, Skeleton, SkipLink } from '@tmanage/ui';
import { Wordmark } from '../brand/Wordmark';
import { browserApiClient } from '../../lib/api/browser-client';
import { listPublicPlans } from '../../lib/api/public-plans';
import type { PublicPlanView } from '../../lib/api/public-plans';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PricingScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Pricing (x157).** `38-MODULE-MAP` §Public site — the public pricing page, audit rank #1.
 *
 * A `@Public()` marketing page: no session, no organization, no tenant. It reads the static plan
 * catalog from `GET /v1/public/site/plans` and lays the tiers out as cards with a feature list each,
 * so the reader can compare them side by side.
 *
 * ## Display and selection only — never payment
 *
 * This screen shows numbers and copy. It stores nothing, posts nothing, and takes no card details:
 * real payment and checkout are a later, Needs-Peter concern (NEXT-SCOPES-13). The call to action
 * carries only the chosen tier id — held in React state as the reader picks a card — and forwards it
 * to the existing sign-in / sign-up flow as a query on `/sign-in`. A tier id is a public catalog key,
 * not personal or sensitive data, so it is safe in a URL; nothing else about the reader is.
 *
 * ## Landmarks are the screen's own here
 *
 * There is no `AppShell` (that needs a tenant) and no `IdentityShell` (a narrow auth card). So this
 * screen supplies its own `A11Y-01` landmarks — a skip link, one `<main>`, one `<h1>` — directly, and
 * `expectNoAxeViolations` in the test holds them in place.
 */
export function PricingScreen({ client }: PricingScreenProps) {
  const api = client ?? browserApiClient();

  const plans = useQuery({
    queryKey: ['public-plans'],
    queryFn: () => listPublicPlans(api),
  });

  const rows = useMemo(() => plans.data ?? [], [plans.data]);

  // The chosen tier, carried in state. It defaults to the recommended tier (or the first) once the
  // catalog loads, so the continue action always has a valid target and never a payment.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const effectiveChoice = chosenId ?? rows.find((tier) => tier.featured)?.id ?? rows[0]?.id ?? null;

  return (
    <LiveAnnouncer>
      <div className="tm-identity">
        <SkipLink targetId="tm-main" />

        <main id="tm-main" className="tm-stack" tabIndex={-1}>
          <header className="tm-stack">
            <Wordmark />
            <h1>Simple pricing for teams doing client work</h1>
            <p className="tm-field__hint">
              Pick the plan that fits, then create your account. You can change plan later — nothing
              here charges a card.
            </p>
          </header>

          {plans.isError ? (
            <InlineAlert tone="danger" title="Could not load pricing" live>
              {describeError(plans.error)}
            </InlineAlert>
          ) : null}

          {plans.isPending ? (
            <LoadingRegion label="Loading pricing.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!plans.isPending && !plans.isError && rows.length > 0 ? (
            <section className="tm-stack" aria-labelledby="tm-pricing-heading">
              <h2 id="tm-pricing-heading" className="tm-eyebrow">
                Plans
              </h2>
              <ul className="tm-list">
                {rows.map((tier) => (
                  <li key={tier.id}>
                    <PlanCard
                      tier={tier}
                      chosen={tier.id === effectiveChoice}
                      onChoose={() => setChosenId(tier.id)}
                    />
                  </li>
                ))}
              </ul>

              {effectiveChoice !== null ? (
                <p className="tm-stack">
                  <Link
                    className="tm-button tm-button--primary"
                    href={`/sign-in?plan=${encodeURIComponent(effectiveChoice)}`}
                  >
                    Continue to sign up
                  </Link>
                  <span className="tm-field__hint">
                    No payment is taken here. You will set up billing after your account exists.
                  </span>
                </p>
              ) : null}
            </section>
          ) : null}
        </main>
      </div>
    </LiveAnnouncer>
  );
}

function PlanCard({
  tier,
  chosen,
  onChoose,
}: {
  tier: PublicPlanView;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <article className="tm-panel tm-stack" aria-labelledby={`tm-plan-${tier.id}`}>
      <div className="tm-row tm-row--wrap">
        <h3 id={`tm-plan-${tier.id}`}>{tier.name}</h3>
        {tier.featured ? <span className="tm-eyebrow">Recommended</span> : null}
      </div>

      <p className="tm-price">
        <span className="tm-price__amount">
          {formatPrice(tier.monthlyPriceCents, tier.currency)}
        </span>
        {tier.monthlyPriceCents > 0 ? (
          <span className="tm-field__hint"> / member / month</span>
        ) : null}
      </p>
      <p className="tm-field__hint">{tier.seatRule}</p>
      <p>{tier.tagline}</p>

      <ul className="tm-list">
        {tier.features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>

      <button type="button" className="tm-button" aria-pressed={chosen} onClick={onChoose}>
        {chosen ? `${tier.name} selected` : `Choose ${tier.name}`}
      </button>
    </article>
  );
}

function formatPrice(monthlyPriceCents: number, currency: string): string {
  if (monthlyPriceCents === 0) return 'Free';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 0,
    }).format(monthlyPriceCents / 100);
  } catch {
    // An unknown currency code should never blank the price — fall back to a plain amount.
    return `${(monthlyPriceCents / 100).toFixed(0)} ${currency.toUpperCase()}`;
  }
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
