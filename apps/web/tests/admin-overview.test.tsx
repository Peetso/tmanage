import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminOverviewScreen } from '../src/components/screens/AdminOverviewScreen';
import { invitationsWaiting, relativeWhen } from '../src/lib/api/admin-overview';

/** OPS-1 Overview: live counts in the four cards, the newest audit rows, the section breadcrumb. */

const NOW = new Date('2026-10-22T10:00:00Z');

const BODIES: readonly [string, unknown][] = [
  [
    '/admin/overview',
    {
      activeMembers: 24,
      seatsUsed: 28,
      storageBytesUsed: 0,
      auditWindowDays: 30,
      auditEventsWindow: 9,
      openOffboardings: 1,
      computedAt: NOW.toISOString(),
    },
  ],
  [
    '/oauth/grants',
    {
      owner: true,
      viewerName: 'Maya Hassan',
      aiAccessEnabled: true,
      apps: ['a', 'b', 'c', 'd'].map((id) => ({
        id,
        clientName: id,
        verified: id !== 'd',
        scopes: [],
        memberName: 'Maya Hassan',
        mine: true,
        connectedAt: NOW.toISOString(),
        lastUsedAt: null,
      })),
    },
  ],
  ['/automations/templates', { templates: [{ enabled: true }, { enabled: false }] }],
  ['/admin/security', { enforce2fa: true, ipAllowlist: [] }],
  [
    '/audit/events',
    {
      events: [
        {
          id: 'e1',
          occurredAt: '2026-10-22T09:58:00Z',
          actorId: null,
          action: 'member.joined',
          entityType: 'membership',
          entityId: null,
          result: 'allowed',
          summary: 'A member joined the organization',
        },
      ],
    },
  ],
];

function overviewClient(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((url: string) => {
      const body = BODIES.find(([path]) => url.includes(path))?.[1];
      return Promise.resolve(
        new Response(JSON.stringify(body ?? {}), {
          status: body ? 200 : 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'correlation-fixed',
  });
}

describe('AdminOverviewScreen — OPS-1 Overview', () => {
  it('renders the live counts, the audit rows and the breadcrumb section', async () => {
    const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queries.setQueryData(
      ['shell', 'organizations'],
      [{ id: 'o1', slug: 'northstar-studio', name: 'Northstar Studio', role: 'owner' }],
    );
    render(
      <QueryClientProvider client={queries}>
        <AdminOverviewScreen
          organizationSlug="northstar-studio"
          organizationName="Northstar Studio"
          client={overviewClient()}
          now={NOW}
        />
      </QueryClientProvider>,
    );

    const cards = await screen.findByRole('list', { name: 'Organization health' });
    expect(await within(cards).findByText('24')).toBeInTheDocument();
    expect(await within(cards).findByText('4')).toBeInTheDocument();
    expect(await within(cards).findByText('1')).toBeInTheDocument();
    expect(await screen.findByText('A member joined the organization')).toBeInTheDocument();
    expect(screen.getByText('2 minutes ago')).toBeInTheDocument();

    const crumb = document.querySelector('.tm-cc-crumbs li[aria-current="page"]');
    expect(crumb).toHaveTextContent('Overview');
    expect(await screen.findByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await screen.findByText('MH')).toBeInTheDocument();
  });

  it('counts waiting invitations from the seat counters, never below zero', () => {
    const base = {
      activeMembers: 24,
      seatsUsed: 28,
      storageBytesUsed: 0,
      auditWindowDays: 30,
      auditEventsWindow: 0,
      openOffboardings: 1,
      computedAt: '',
    };
    expect(invitationsWaiting(base)).toBe(3);
    expect(invitationsWaiting({ ...base, seatsUsed: 10 })).toBe(0);
    expect(relativeWhen('2026-10-21T10:00:00Z', NOW, 'en')).toBe('yesterday');
  });
});
