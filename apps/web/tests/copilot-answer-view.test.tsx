import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { CopilotAnswerView } from '../src/components/screens/CopilotAnswerView';
import { SearchScreen } from '../src/components/screens/SearchScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * **Module 16 AI copilot — web answer view (slice 05).**
 *
 * The two gates (flag off → 404, missing capability → 403) and the provider seam are proved over
 * fakes in `apps/api/src/modules/copilot/copilot.controller.test.ts`; nothing here re-proves them.
 * What only this file can prove is what the *web* does with the answer: it renders the three regions
 * the module map requires — the answer, the evidence (each linking to its in-app source), and the
 * permission boundary — plus a primary next-safe-action, and that the Search screen surfaces the
 * "Ask copilot" affordance only when the `copilot` feature flag resolves on.
 */

interface Call {
  readonly url: string;
}

function clientOver(handler: (call: Call) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler({ url: String(input) }))) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const ANSWER = {
  answer: 'The copilot is running in offline preview, so this is a guided answer.',
  evidence: [
    { source: 'Global search', link: '/search?q=launch' },
    { source: 'Command palette', link: '/search/commands' },
  ],
  permissionBoundary: {
    scope: 'assigned-projects',
    canSee: 'the projects you are a member of',
    cannotSee: 'projects you are not a member of, and client-only data',
  },
  nextSafeAction: 'Open global search for "launch" to review the underlying records yourself.',
  provider: 'local-stub',
};

describe('CopilotAnswerView', () => {
  it('renders the answer, evidence links, permission boundary and next-safe-action', async () => {
    const client = clientOver((call) => {
      if (call.url.includes('/copilot/ask')) return json(ANSWER);
      return json({}, 404);
    });

    const { container } = render(
      withQuery(
        <CopilotAnswerView
          organizationSlug="acme"
          organizationName="Acme"
          initialQuestion="launch"
          client={client}
        />,
      ),
    );

    // The answer region, naming the provider so the offline stub is not mistaken for a real model.
    expect(await screen.findByText(/guided answer/i)).toBeInTheDocument();
    expect(screen.getByText(/local-stub/i)).toBeInTheDocument();

    // The evidence region: at least one item, linking to its in-app source (org-prefixed).
    const evidence = screen.getByRole('list', { name: /evidence behind this answer/i });
    const links = within(evidence).getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(within(evidence).getByRole('link', { name: 'Global search' })).toHaveAttribute(
      'href',
      '/acme/search?q=launch',
    );

    // The permission boundary, rendered from the server's scope (not re-derived on the client).
    expect(screen.getByText(/your assigned projects/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot see:/i)).toBeInTheDocument();

    // The primary next-safe-action, a link to the first cited (read-only) surface.
    expect(screen.getByRole('link', { name: /open global search for/i })).toHaveAttribute(
      'href',
      '/acme/search?q=launch',
    );

    await expectNoAxeViolations(container);
  });
});

function searchClient(copilot: boolean): ApiClient {
  return clientOver((call) => {
    if (call.url.includes('/feature-flags')) return json({ flags: { copilot } });
    if (call.url.includes('/search')) return json({ results: [] });
    return json({}, 404);
  });
}

describe('SearchScreen copilot affordance', () => {
  it('shows "Ask copilot" only when the copilot flag resolves on', async () => {
    render(
      withQuery(
        <SearchScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={searchClient(true)}
        />,
      ),
    );
    const link = await screen.findByRole('link', { name: /ask copilot/i });
    expect(link).toHaveAttribute('href', '/acme/copilot');
  });

  it('renders no "Ask copilot" affordance when the flag is off', async () => {
    render(
      withQuery(
        <SearchScreen
          organizationSlug="acme"
          organizationName="Acme"
          client={searchClient(false)}
          initialQuery="alpha"
        />,
      ),
    );
    // The empty-state appears once the search resolves — a milestone by which the parallel flag
    // query has also settled — so the absence of the affordance is a real off-state, not a race.
    await screen.findByText(/no matches/i);
    expect(screen.queryByRole('link', { name: /ask copilot/i })).toBeNull();
  });
});
