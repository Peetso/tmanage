import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { MarketingResourcesScreen } from '../src/components/screens/MarketingResourcesScreen';
import { MarketingResourceScreen } from '../src/components/screens/MarketingResourceScreen';
import { expectNoAxeViolations } from './axe';

/**
 * Public resources/guides (module 1, x187) — the index and article render the public content and are
 * accessible. The endpoints they read are `@Public()` on the API, so the screens carry no
 * organization and no session; the fake client returns the payload (or a 404 for the not-found case).
 */
function client(body: unknown, status = 200): ApiClient {
  return new ApiClient({
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
}

function mount(node: ReactElement) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={query}>{node}</QueryClientProvider>);
}

const LIST = {
  resources: [
    {
      slug: 'getting-started',
      title: 'Getting started with TManage',
      summary: 'Set up your first project.',
      category: 'Guides',
    },
    {
      slug: 'client-portal-tour',
      title: 'A tour of the client portal',
      summary: 'What clients see.',
      category: 'Guides',
    },
  ],
};

const ARTICLE = {
  slug: 'getting-started',
  title: 'Getting started with TManage',
  summary: 'Set up your first project.',
  category: 'Guides',
  body: 'TManage brings projects, approvals, and the client portal into one place.',
};

describe('MarketingResourcesScreen', () => {
  it('renders the index heading and a linked card per resource', async () => {
    mount(<MarketingResourcesScreen client={client(LIST)} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Resources & guides' }),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: LIST.resources[0]!.title });
    expect(link).toHaveAttribute('href', '/resources/getting-started');
  });

  it('has no axe violations once loaded', async () => {
    const { container } = mount(<MarketingResourcesScreen client={client(LIST)} />);
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: 'Resources & guides' }),
      ).toBeInTheDocument(),
    );
    await expectNoAxeViolations(container);
  });
});

describe('MarketingResourceScreen', () => {
  it('renders a known article with its body', async () => {
    mount(<MarketingResourceScreen slug="getting-started" client={client(ARTICLE)} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: ARTICLE.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(ARTICLE.body)).toBeInTheDocument();
  });

  it('shows an honest not-found for a slug the catalog does not name', async () => {
    mount(
      <MarketingResourceScreen slug="no-such-guide" client={client({ code: 'not_found' }, 404)} />,
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Resource not found' }),
    ).toBeInTheDocument();
  });
});
