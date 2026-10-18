'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CSSProperties } from 'react';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { OrbLink, PublicIntro, PublicPage } from './public/PublicSite';
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
 * ## Layout and landmarks
 *
 * Drawn to PUB-04: a display headline, one card per catalog tier (the featured tier is the lime
 * card), and the dashed "How usage works" card that also carries the continue action. There is no
 * `AppShell` (that needs a tenant); `PublicPage` supplies the `A11Y-01` landmarks — skip link,
 * banner, one `<main>` — and this screen owns the one `<h1>`. `expectNoAxeViolations` in the test
 * holds them in place.
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
    <PublicPage current="pricing">
      <section className="tm-pub-section" aria-labelledby="tm-pricing-title">
        <div className="tm-pub-head">
          <PublicIntro
            eyebrow="Pricing"
            titleId="tm-pricing-title"
            size="md"
            title={
              <>
                Priced per internal seat.
                <br />
                Client users are free.
              </>
            }
          />
        </div>

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
          <div className="tm-pub-plans" style={{ '--plan-count': rows.length } as CSSProperties}>
            <h2 id="tm-pricing-heading" className="tm-visually-hidden">
              Plans
            </h2>
            {rows.map((tier) => (
              <PlanCard
                key={tier.id}
                tier={tier}
                chosen={tier.id === effectiveChoice}
                onChoose={() => setChosenId(tier.id)}
              />
            ))}

            <aside className="tm-pub-usage" aria-labelledby="tm-usage-title">
              <h2 id="tm-usage-title" className="tm-pub-card__eyebrow tm-pub-card__eyebrow--wide">
                How usage works
              </h2>
              <p>
                A seat is an internal person who creates or owns work. Client reviewers, sponsors
                and viewers never consume a seat.
              </p>
              <p>
                Pick the plan that fits, then create your account. You can change plan later —
                nothing here charges a card.
              </p>
              {effectiveChoice !== null ? (
                <>
                  <p>
                    No payment is taken here. You will set up billing after your account exists.
                  </p>
                  <OrbLink href={`/sign-in?plan=${encodeURIComponent(effectiveChoice)}`}>
                    Continue to sign up
                  </OrbLink>
                </>
              ) : null}
            </aside>
          </div>
        ) : null}
      </section>
    </PublicPage>
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
    <article
      className={`tm-pub-plan${tier.featured ? ' tm-pub-plan--featured' : ''}`}
      aria-labelledby={`tm-plan-${tier.id}`}
    >
      <div className="tm-pub-plan__name-row">
        <h3 id={`tm-plan-${tier.id}`} className="tm-pub-plan__name">
          {tier.name}
        </h3>
        {tier.featured ? <span className="tm-pub-plan__badge">Most teams start here</span> : null}
      </div>

      <p className="tm-pub-plan__price">
        <span className="tm-pub-plan__amount">
          {formatPrice(tier.monthlyPriceCents, tier.currency)}
        </span>
        <span className="tm-pub-plan__unit">{tier.seatRule}</span>
      </p>
      <p className="tm-pub-plan__tagline">{tier.tagline}</p>
      <div className="tm-pub-plan__rule" aria-hidden="true" />

      <ul className="tm-pub-plan__features">
        {tier.features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>

      <button type="button" className="tm-pub-btn" aria-pressed={chosen} onClick={onChoose}>
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
