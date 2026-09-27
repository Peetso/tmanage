import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { CommandPalette } from '../src/components/screens/CommandPalette';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * SRCH command palette (x181). The API gate, matcher ranking and no-injection are proved in the
 * controller unit; this file proves only what the screen does with the response: an opened palette is
 * a focus-trapped, axe-clean dialog that renders the commands the API returns.
 */

function clientReturning(commands: unknown): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ commands }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={query}>{children}</QueryClientProvider>;
}

describe('CommandPalette', () => {
  it('renders an opened palette as an axe-clean dialog listing the returned commands', async () => {
    const client = clientReturning([
      {
        id: 'nav-work',
        title: 'Go to Work',
        section: 'Navigate',
        kind: 'navigate',
        href: '/work',
        action: null,
      },
    ]);
    const { container } = render(
      withQuery(<CommandPalette organizationSlug="acme" client={client} initiallyOpen />),
    );

    const dialog = await screen.findByRole('dialog', { name: 'Command palette' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => expect(screen.getByText('Go to Work')).toBeInTheDocument());
    await expectNoAxeViolations(container);
  });
});
