import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { MeetingSeriesScreen } from '../src/components/screens/MeetingSeriesScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * CAL recurrence web (x129). The API's tenant scoping, the `meeting.read`/`meeting.write` gates, the
 * 90-day window cap and the pure expansion are proved in the controller unit test and the chain's DB
 * suite; nothing here re-proves them. What only this file can prove is what the *screen* does with
 * those answers: it lists a tenant's series and creates one, and the mounted document is axe-clean.
 */

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function clientOver(handler: (call: Call) => Response): { client: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
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

const NOW = '2026-09-01T12:00:00.000Z';

function seriesView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'series-1',
    title: 'Weekly sync',
    freq: 'weekly',
    interval: 1,
    until: null,
    createdByUserId: 'user-1',
    createdAt: NOW,
    ...overrides,
  };
}

describe('MeetingSeriesScreen', () => {
  it("lists a tenant's series and is axe-clean", async () => {
    const { client } = clientOver((call) => {
      if (call.url.includes('/meeting-series')) {
        return json({ series: [seriesView()] });
      }
      return json({}, 200);
    });
    const { container } = render(
      withQuery(
        <MeetingSeriesScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    expect(await screen.findByRole('rowheader', { name: 'Weekly sync' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create series' })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it('posts a new series behind meeting.write', async () => {
    const created: Call[] = [];
    const { client } = clientOver((call) => {
      if (call.method === 'POST' && call.url.includes('/meeting-series')) {
        created.push(call);
        return json(
          seriesView({ id: 'series-2', title: 'Retro', freq: 'monthly', interval: 2 }),
          201,
        );
      }
      if (call.url.includes('/meeting-series')) return json({ series: [] });
      return json({}, 200);
    });

    render(
      withQuery(
        <MeetingSeriesScreen organizationSlug="acme" organizationName="Acme" client={client} />,
      ),
    );

    // Wait for the empty-series read so the create form is settled.
    await screen.findByRole('button', { name: 'Create series' });

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retro' } });
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'monthly' } });
    fireEvent.change(screen.getByLabelText('Every'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create series' }));

    await waitFor(() => expect(created.length).toBe(1));
    const body = JSON.parse(created[0]!.body as string) as Record<string, unknown>;
    expect(body['title']).toBe('Retro');
    expect(body['freq']).toBe('monthly');
    expect(body['interval']).toBe(2);
  });
});
