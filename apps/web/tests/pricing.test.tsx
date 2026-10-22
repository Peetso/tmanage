import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PricingScreen } from '../src/components/screens/PricingScreen';
import { PricingPage } from '../src/components/website/pages/pricing/PricingPage';
import { PRICING_PLANS } from '../src/components/website/pages/pricing/pricing-data';
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
 * **Website /pricing in Arabic (live check 014a9d51, report lines 106-107).** The plan cards, their
 * calls to action, the feature lines and the "How it's counted" badges used to be literals, so an
 * ar-EG visitor read them in English. Every word now comes from the catalog.
 */
describe('PricingPage (website /pricing)', () => {
  afterEach(() => activeLocale.set('en-US'));

  /** The English copy the live check found on the Arabic page. */
  const ENGLISH_CARD_COPY = [
    'For a small team trying TManage on real client work.',
    'Start free',
    'Choose Starter',
    'Choose Studio',
    'Choose Business',
    'Contact sales',
    'Everything in Free',
    'Unlimited clients',
    'Work, chat and calendar',
    'Roles and permissions',
    'Audit log',
    'SSO and SCIM',
    'Data residency',
    'Named success lead',
    'Free, always',
    'Counted once',
    'Pooled per workspace',
    '3 seats',
  ];

  const ar = (key: string) => translate('ar-EG', key as MessageKey);

  it('ar-EG: no English card copy or badge remains, and each card reads from the catalog', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <div dir="rtl">
        <PricingPage />
      </div>,
    );

    const cards = [...container.querySelectorAll<HTMLElement>('.tm-pricing-plan')];
    expect(cards).toHaveLength(PRICING_PLANS.length);
    const visible = [
      ...cards.map((card) => card.textContent ?? ''),
      container.querySelector('.tm-pricing-rules')?.textContent ?? '',
    ].join(' ');
    for (const english of ENGLISH_CARD_COPY) expect(visible).not.toContain(english);

    PRICING_PLANS.forEach((plan, i) => {
      const card = within(cards[i]!);
      expect(card.getByRole('heading', { level: 3 }).textContent).toBe(ar(plan.nameKey));
      expect(card.getByText(ar(plan.positioningKey))).toBeInTheDocument();
      expect(card.getByRole('link', { name: ar(plan.cta.labelKey) })).toHaveAttribute(
        'href',
        plan.cta.href,
      );
      for (const key of plan.featureKeys) expect(card.getByText(ar(key))).toBeInTheDocument();
    });
  });

  it('keeps the CTA targets: sign-up for every self-serve plan, contact for Enterprise', () => {
    for (const plan of PRICING_PLANS) {
      expect(plan.cta.href).toBe(plan.id === 'enterprise' ? '/contact' : SIGN_UP_HREF);
    }
  });

  it('ar-EG: the featured Studio card and the plan picker still work', () => {
    activeLocale.set('ar-EG');
    const { container } = render(<PricingPage />);

    const featured = container.querySelectorAll('.tm-pricing-plan--featured');
    expect(featured).toHaveLength(1);
    expect(featured[0]!.getAttribute('aria-labelledby')).toBe('plan-studio');
    expect(within(featured[0] as HTMLElement).getByText(ar('PricingPage.planFlag'))).toBeVisible();

    // Studio is the plan shown by default; the picker lists every plan by its catalog name.
    const active = () => container.querySelector('.tm-pricing-plan.is-active');
    expect(active()?.getAttribute('aria-labelledby')).toBe('plan-studio');
    const [picker] = screen.getAllByLabelText(ar('PricingPage.showPlan'));
    const options = within(picker!).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(
      PRICING_PLANS.map((plan) => ar(plan.nameKey)),
    );

    fireEvent.change(picker!, { target: { value: 'enterprise' } });
    expect(active()?.getAttribute('aria-labelledby')).toBe('plan-enterprise');
    expect(container.querySelector('.tm-pricing-compare__plan.is-active')?.textContent).toBe(
      ar('PricingPage.planEnterpriseName'),
    );
  });
});
