import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PricingScreen } from '../src/components/screens/PricingScreen';
import { PricingPage } from '../src/components/website/pages/pricing/PricingPage';
import {
  BETA_FAQ,
  BETA_INCLUDED,
  PRICING_PLANS,
  planPrice,
} from '../src/components/website/pages/pricing/pricing-data';
import { ApiClient } from '../src/lib/api/client';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { translate, type MessageKey } from '../src/lib/i18n/t';
import { SIGN_UP_HREF } from '../src/lib/public-signup';
import { expectNoAxeViolations } from './axe';

/**
 * **Pricing (x157).**
 *
 * The catalog's content and the public route are proved over the real service in
 * `apps/api/src/modules/public-site/plan-catalog.controller.test.ts`; nothing here re-proves them.
 *
 * What only this file can prove is what the *screen* does with the tiers the endpoint returns: it
 * renders one card per tier in server order, shows a price and a seat rule on each, forwards only the
 * chosen tier id to the sign-in flow (no payment, no other data), and carries accessible landmarks and
 * headings with no axe violation jsdom can detect.
 */

function clientOver(handler: () => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() => Promise.resolve(handler())) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    tagline: 'A first project.',
    monthlyPriceCents: 0,
    currency: 'usd',
    seatRule: 'Up to 3 members',
    featured: false,
    features: ['1 workspace'],
  },
  {
    id: 'business',
    name: 'Business',
    tagline: 'Control and an audit trail.',
    monthlyPriceCents: 2400,
    currency: 'usd',
    seatRule: 'Per member, billed monthly',
    featured: true,
    features: ['Custom roles', 'Full audit log'],
  },
];

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('PricingScreen', () => {
  it('renders one card per tier with a price and a seat rule, and is accessible', async () => {
    const client = clientOver(() => json({ plans: PLANS }));
    const { container } = render(withQuery(<PricingScreen client={client} />));

    // One card per tier, in server order.
    const cards = await screen.findAllByRole('article');
    expect(
      cards.map((card) => within(card).getByRole('heading', { level: 3 }).textContent),
    ).toEqual(['Free', 'Business']);
    // Each tier shows a price and its seat rule; a paid tier's price is formatted from cents.
    expect(within(cards[0]!).getByText('Up to 3 members')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('$24')).toBeInTheDocument();
    expect(within(cards[1]!).getByText('Per member, billed monthly')).toBeInTheDocument();

    // Exactly one <h1> for the page, and no axe violation.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it('forwards only the chosen tier id to the sign-in flow — no payment, nothing else', async () => {
    const client = clientOver(() => json({ plans: PLANS }));
    render(withQuery(<PricingScreen client={client} />));

    // Defaults to the recommended tier; the continue link carries just that tier id.
    const link = await screen.findByRole('link', { name: 'Continue to sign up' });
    expect(link).toHaveAttribute('href', '/sign-in?plan=business');
  });

  it('shows a plain error rather than a blank page when the catalog cannot load', async () => {
    const client = clientOver(() =>
      json({ error: { code: 'internal_error', message: 'nope' } }, 500),
    );
    render(withQuery(<PricingScreen client={client} />));
    expect(await screen.findByText('Could not load pricing')).toBeInTheDocument();
  });
});

/**
 * **Website /pricing (approved Figma section 376:2087, pr-desktop / pr-mobile).** Flat prices for
 * the whole team, yearly −20 %, kept in the data for later; during the public beta the page shows
 * one free card (Figma 415:23716 / 418:9605), no billing switch and no per-seat wording.
 * The page's new words arrive through the wave's i18n fragment, so expectations read the catalog
 * (`L` / `ar`) rather than literals and hold before and after the fragment is merged.
 */
describe('PricingPage (website /pricing)', () => {
  afterEach(() => activeLocale.set('en-US'));

  const L = (key: string) => translate('en-US', key as MessageKey);
  const ar = (key: string) => translate('ar-EG', key as MessageKey);

  it('yearly maths: monthly × 0.8 per month, ×12 a year, two decimals', () => {
    const byId = Object.fromEntries(PRICING_PLANS.map((plan) => [plan.id, plan.monthlyCents]));
    expect(byId).toEqual({
      free: 0,
      starter: 1900,
      studio: 4900,
      business: 8900,
      enterprise: null,
    });
    expect(planPrice(1900, 'yearly')).toEqual({
      perMonth: '$15.20',
      perYear: '$182.40',
      monthly: '$19',
      yearlyPerMonth: '$15.20',
    });
    expect(planPrice(4900, 'yearly').perYear).toBe('$470.40');
    expect(planPrice(8900, 'yearly').perMonth).toBe('$71.20');
    expect(planPrice(8900, 'yearly').perYear).toBe('$854.40');
    expect(planPrice(4900, 'monthly').perMonth).toBe('$49');
  });

  it('beta: one free card for the whole team, no billing switch, no seats, no paid tiers', () => {
    const { container } = render(<PricingPage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(L('PricingPage.betaTitle'));
    const card = within(screen.getByRole('article', { name: L('PricingPage.betaCardTitle') }));
    expect(card.getByText('$0')).toBeInTheDocument();
    expect(card.getByText(L('PricingPage.betaUnit'))).toBeInTheDocument();
    expect(card.getByRole('link', { name: L('PricingPage.startFree') })).toHaveAttribute(
      'href',
      SIGN_UP_HREF,
    );
    for (const key of BETA_INCLUDED) expect(card.getByText(L(key))).toBeInTheDocument();
    expect(card.getByText(L('PricingPage.betaAfterBody'))).toBeInTheDocument();

    // No period switch, no paid tier, no seat wording, no comparison, no price but $0.
    expect(screen.queryByRole('group')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelectorAll('.tm-pricing-plan')).toHaveLength(0);
    expect(container.querySelector('table')).toBeNull();
    const cardText = container.querySelector('.tm-pricing-beta')?.textContent ?? '';
    expect(cardText).not.toMatch(/\bseats?\b/i);
    expect((container.textContent ?? '').match(/\$\d+/g)).toEqual(['$0']);
  });

  it('beta FAQ: six questions with their answers', () => {
    render(<PricingPage />);
    expect(screen.getByRole('heading', { name: L('PricingPage.betaFaqTitle') })).toBeVisible();
    expect(BETA_FAQ).toHaveLength(6);
    for (const item of BETA_FAQ) {
      expect(screen.getByText(L(item.questionKey))).toBeInTheDocument();
      expect(screen.getByText(L(item.answerKey))).toBeInTheDocument();
    }
  });

  it('ar-EG: renders right-to-left from the Arabic catalog', async () => {
    activeLocale.set('ar-EG');
    const { container } = render(<PricingPage />);
    expect(container.querySelector('.tm-pricing')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ar('PricingPage.betaTitle'));
    const card = within(screen.getByRole('article', { name: ar('PricingPage.betaCardTitle') }));
    expect(card.getByRole('link', { name: ar('PricingPage.startFree') })).toHaveAttribute(
      'href',
      SIGN_UP_HREF,
    );
    for (const key of BETA_INCLUDED) expect(card.getByText(ar(key))).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
