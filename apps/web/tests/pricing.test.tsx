import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { PricingScreen } from '../src/components/screens/PricingScreen';
import { ApiClient } from '../src/lib/api/client';
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
