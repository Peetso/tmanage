import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PricingScreen } from '../src/components/screens/PricingScreen';
import { PricingPage } from '../src/components/website/pages/pricing/PricingPage';
import { PRICING_PLANS, planPrice } from '../src/components/website/pages/pricing/pricing-data';
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
 * the whole team, yearly −20 %, the founding offer, and no per-seat wording anywhere on a card.
 * The page's new words arrive through the wave's i18n fragment, so expectations read the catalog
 * (`L` / `ar`) rather than literals and hold before and after the fragment is merged.
 */
describe('PricingPage (website /pricing)', () => {
  afterEach(() => activeLocale.set('en-US'));

  const L = (key: string) => translate('en-US', key as MessageKey);
  const ar = (key: string) => translate('ar-EG', key as MessageKey);
  const fill = (text: string, amount: string) => text.replace('{amount}', amount);
  const cardOf = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[aria-labelledby="plan-${id}"]`)!;

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

  it('opens on yearly as drawn and the toggle switches every paid card to monthly', () => {
    const { container } = render(<PricingPage />);
    const starter = within(cardOf(container, 'starter'));
    expect(starter.getByText('$15.20')).toBeInTheDocument();
    expect(starter.getByText(fill(L('PricingPage.flatPerYear'), '$182.40'))).toBeInTheDocument();
    expect(starter.getByText(fill(L('PricingPage.ifBilledMonthly'), '$19'))).toBeInTheDocument();
    expect(within(cardOf(container, 'studio')).getByText('$39.20')).toBeInTheDocument();
    expect(within(cardOf(container, 'business')).getByText('$71.20')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: L('PricingPage.toggleMonthly') }));
    expect(within(cardOf(container, 'starter')).getByText('$19')).toBeInTheDocument();
    expect(within(cardOf(container, 'studio')).getByText('$49')).toBeInTheDocument();
    expect(within(cardOf(container, 'business')).getByText('$89')).toBeInTheDocument();
    // Free and Enterprise never change with the period.
    expect(within(cardOf(container, 'free')).getByText('$0')).toBeInTheDocument();
    expect(
      within(cardOf(container, 'enterprise')).getByText(L('PricingPage.customPrice')),
    ).toBeInTheDocument();
  });

  it('shows the founding offer banner linking to /contact, and no comparison table', () => {
    const { container } = render(<PricingPage />);
    const banner = screen.getByRole('complementary', { name: L('PricingPage.foundingBadge') });
    expect(within(banner).getByText(L('PricingPage.foundingText'))).toBeInTheDocument();
    expect(
      within(banner).getByRole('link', { name: L('PricingPage.foundingCta') }),
    ).toHaveAttribute('href', '/contact');
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByRole('heading', { name: L('PricingPage.basecampTitle') })).toBeVisible();
  });

  it('no per-seat word on any card, and the CTAs keep their targets', () => {
    const { container } = render(<PricingPage />);
    const cards = [...container.querySelectorAll<HTMLElement>('.tm-pricing-plan')];
    expect(cards).toHaveLength(5);
    for (const card of cards) {
      expect(card.textContent ?? '').not.toMatch(/seat/i);
      expect(card.textContent ?? '').not.toContain(L('PricingPage.seatWord'));
    }
    for (const plan of PRICING_PLANS) {
      expect(plan.cta.href).toBe(plan.id === 'enterprise' ? '/contact' : SIGN_UP_HREF);
    }
    const featured = container.querySelectorAll('.tm-pricing-plan--featured');
    expect(featured).toHaveLength(1);
    expect(featured[0]!.getAttribute('aria-labelledby')).toBe('plan-studio');
  });

  it('ar-EG: renders right-to-left from the Arabic catalog', () => {
    activeLocale.set('ar-EG');
    const { container } = render(<PricingPage />);
    expect(container.querySelector('.tm-pricing')).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(ar('PricingPage.flatTitle'));

    const cards = [...container.querySelectorAll<HTMLElement>('.tm-pricing-plan')];
    PRICING_PLANS.forEach((plan, i) => {
      const card = within(cards[i]!);
      expect(card.getByRole('heading', { level: 3 }).textContent).toBe(ar(plan.nameKey));
      expect(card.getByRole('link', { name: ar(plan.cta.labelKey) })).toHaveAttribute(
        'href',
        plan.cta.href,
      );
      for (const key of plan.featureKeys) expect(card.getByText(ar(key))).toBeInTheDocument();
    });
    // The Latin tier names carry U+200F in Arabic, like the catalog.
    expect(ar('PricingPage.planStudioName').startsWith('‏')).toBe(true);
  });
});
