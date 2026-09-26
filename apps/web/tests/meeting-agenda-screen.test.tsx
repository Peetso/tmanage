import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingAgendaScreen } from '../src/components/screens/MeetingAgendaScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * CAL agenda / day view web (x127). The API's tenant scoping, the `meeting.read` gate and the
 * window clamp are proved in the controller unit test and (in the chain) the database suite; nothing
 * here re-proves them. What only this file can prove is what the *screen* does with the grouped
 * response:
 *
 * - it reads the agenda over the chosen `from`/`to` window and renders one day heading per day,
 *   linking each meeting to its detail page;
 * - the mounted document is axe-clean (A11Y-01).
 */

interface Call {
  readonly url: string;
  readonly method: string;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), method: init?.method ?? 'GET' };
      calls.push(call);
      return Promise.resolve(handler(call));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  return { client, calls };
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

const AGENDA = {
  range: { from: '2026-10-01', to: '2026-10-31' },
  days: [
    {
      date: '2026-10-01',
      meetings: [
        {
          id: 'meeting-1',
          projectId: 'project-1',
          title: 'Kickoff',
          startsAt: '2026-10-01T14:00:00.000Z',
          agendaNote: null,
          createdByUserId: 'user-1',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
    {
      date: '2026-10-03',
      meetings: [
        {
          id: 'meeting-2',
          projectId: 'project-1',
          title: 'Retro',
          startsAt: '2026-10-03T10:00:00.000Z',
          agendaNote: null,
          createdByUserId: 'user-1',
          createdAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  ],
};

describe('MeetingAgendaScreen', () => {
  // The screen's default window is the current UTC calendar month; pin the clock (Date only, so
  // async waits keep real timers) so that default is deterministic and the URL assertion below is
  // exact rather than date-fragile.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the agenda grouped by day and links each meeting to its detail page', async () => {
    const { client, calls } = clientOver((call) => {
      if (call.url.includes('/meetings/agenda?')) return json(AGENDA);
      return json({}, 200);
    });

    const { container } = render(
      withQuery(
        <MeetingAgendaScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    const kickoff = await screen.findByRole('link', { name: 'Kickoff' });
    expect(kickoff).toHaveAttribute('href', '/acme/calendar/meetings/meeting-1');
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Retro' })).toHaveAttribute(
        'href',
        '/acme/calendar/meetings/meeting-2',
      ),
    );

    // The read carried the window to the API — the grouping is the server's.
    expect(
      calls.some((c) => c.url.includes('/meetings/agenda?from=2026-10-01&to=2026-10-31')),
    ).toBe(true);

    await expectNoAxeViolations(container);
  });

  it('shows an empty state when no meetings fall in the range', async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/meetings/agenda?'))
        return json({ range: { from: '2026-10-01', to: '2026-10-31' }, days: [] });
      return json({}, 200);
    });

    const { container } = render(
      withQuery(
        <MeetingAgendaScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    expect(await screen.findByText('Nothing on the agenda yet')).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});
