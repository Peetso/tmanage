import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ClientActionsScreen } from '../src/components/screens/ClientActionsScreen';
import { PortalJourneyStepper } from '../src/components/screens/PortalJourneyStepper';
import { ApiClient } from '../src/lib/api/client';
import { portalActions } from '../src/lib/portal-actions';

/**
 * QA-FIX-O M3 and L10, over a fake API.
 *
 * M3: with a version waiting for the client's decision, the overview counted it while My Actions
 * said "Nothing needs you". Both now read `portalActions`; this proves My Actions lists it.
 * L10: a staff preview of the portal showed "We could not load your project steps", because the
 * journey read answers 404 to anybody who is not one of the project's clients.
 */
vi.mock('../src/lib/i18n/use-t', () => ({ useT: () => (key: string) => key }));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(handler: (url: string) => Response): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(handler(String(input)))) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode, audience: 'client' | 'internal') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(
    ['shell', 'organizations'],
    [
      {
        id: 'o1',
        slug: 'northstar',
        name: 'Northstar Studio',
        audience,
        role: audience === 'client' ? 'client' : 'owner',
        clientOrganizationName: 'Atlas Hospitality',
      },
    ],
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const PROJECT = { id: 'proj-1', name: 'Atlas Website', status: 'active', committedAt: null };

const awaiting = {
  id: 'dv-2',
  deliverableId: 'deliv-1',
  publishedAt: '2026-11-20T08:11:00.000Z',
  title: 'Homepage design v2',
  summary: 'Check the booking button.',
  milestoneState: null,
  forecastDate: null,
  publishedRisk: null,
  decision: null,
  approvedContacts: [],
  review: { state: 'awaiting_decision', awaitingYou: true },
};

describe('M3: one list of what needs the client', () => {
  it('counts a version awaiting the client decision, once, beside waiting work', () => {
    const actions = portalActions({
      workItems: [],
      requests: [],
      deliverables: [awaiting, awaiting, { ...awaiting, id: 'dv-1', review: null }] as never,
    });
    expect(actions.reviews.map((d) => d.id)).toEqual(['dv-2']);
    expect(actions.count).toBe(1);
  });

  it('My Actions lists the version waiting for approval instead of "Nothing needs you"', async () => {
    const client = clientOver((url) => {
      if (url.includes('/portal/projects/proj-1/deliverables')) {
        return json({ deliverables: [awaiting] });
      }
      if (url.includes('/portal/projects')) return json({ projects: [PROJECT] });
      if (url.includes('/portal/work-items')) return json({ workItems: [] });
      if (url.includes('/portal/requests')) return json({ requests: [] });
      return json({});
    });
    render(
      withQuery(
        <ClientActionsScreen
          organizationSlug="northstar"
          clientName="Atlas Hospitality"
          providerName="Northstar Studio"
          client={client}
        />,
        'client',
      ),
    );
    expect(await screen.findByText('Homepage design v2')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: /ClientActionsScreen.reviewAndApprove/u })
        .getAttribute('href'),
    ).toBe('/northstar/portal/deliverables/dv-2');
    expect(screen.queryByText('ClientActionsScreen.nothingWaitingTitle')).toBeNull();
  });
});

describe('L10: the journey card in a staff preview', () => {
  it('shows the empty state, not "could not load", when the API hides the journey (404)', async () => {
    const client = clientOver((url) =>
      url.includes('/journey')
        ? json({ error: { code: 'not_found', message: 'Not found' } }, 404)
        : json({}),
    );
    render(
      withQuery(
        <PortalJourneyStepper
          api={client}
          organizationSlug="northstar"
          projectId="proj-1"
          providerName="Northstar Studio"
        />,
        'internal',
      ),
    );
    expect(await screen.findByText('PortalJourney.empty')).toBeTruthy();
    expect(screen.queryByText('PortalJourney.errorTitle')).toBeNull();
  });

  it('a real client still sees the error when the journey cannot be read', async () => {
    const client = clientOver(() => json({ error: { code: 'not_found', message: 'x' } }, 404));
    render(
      withQuery(
        <PortalJourneyStepper
          api={client}
          organizationSlug="northstar"
          projectId="proj-1"
          providerName="Northstar Studio"
        />,
        'client',
      ),
    );
    expect(await screen.findByText('PortalJourney.errorTitle')).toBeTruthy();
  });
});
