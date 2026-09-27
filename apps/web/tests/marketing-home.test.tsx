import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { MarketingHomeScreen } from '../src/components/screens/MarketingHomeScreen';
import { expectNoAxeViolations } from './axe';

/**
 * Public marketing home (module 1, x156) — the landing page renders the public content and is
 * accessible. The endpoint it reads is `@Public()` on the API, so this screen carries no
 * organization and no session; the fake client just returns the payload.
 */
function mount(body: unknown, status = 200) {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <MarketingHomeScreen client={client} />
    </QueryClientProvider>,
  );
}

const HOME = {
  hero: {
    title: 'Run client work without the status meeting',
    subtitle: 'TManage keeps projects, approvals, and the client portal in one place.',
    primaryCta: { label: 'Get started', href: '/sign-in' },
    secondaryCta: { label: 'Sign in', href: '/sign-in' },
  },
  features: [
    {
      title: 'One place for the work',
      body: 'Projects, tasks, decisions, and documents together.',
    },
    { title: 'A portal your clients trust', body: 'Share deliverables and collect approvals.' },
  ],
};

describe('MarketingHomeScreen', () => {
  it('renders the hero, the feature grid, and the calls to action', async () => {
    mount(HOME);

    expect(
      await screen.findByRole('heading', { level: 1, name: HOME.hero.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(HOME.features[0]!.title)).toBeInTheDocument();
    expect(screen.getByText(HOME.features[1]!.title)).toBeInTheDocument();

    const getStarted = screen.getByRole('link', { name: HOME.hero.primaryCta.label });
    expect(getStarted).toHaveAttribute('href', '/sign-in');
  });

  it('has no axe violations once loaded', async () => {
    const { container } = mount(HOME);
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: HOME.hero.title })).toBeInTheDocument(),
    );
    await expectNoAxeViolations(container);
  });
});
