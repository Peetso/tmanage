import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import type { SupportThread } from '../src/lib/api/support';
import { GetHelpScreen } from '../src/components/support/GetHelpScreen';
import { formatBusinessDuration, slaSummary } from '../src/lib/support-sla-text';

const THREAD = '0199aa00-0000-7000-8000-0000000000e1';
const UNITS = { day: 'day', days: 'days', hour: 'h', minute: 'min' };

function detail(subject: string) {
  return {
    thread: {
      id: THREAD,
      category: 'billing',
      priority: 'high',
      sla: null,
      plan: null,
      subject,
      status: 'open',
      contextPath: '/northstar/settings',
      appVersion: '0.1.0',
      startedByName: 'Lina',
      mine: true,
      messageCount: 1,
      lastAuthorKind: 'member',
      lastMessageAt: '2026-11-08T10:00:00.000Z',
      createdAt: '2026-11-08T10:00:00.000Z',
      closedAt: null,
    },
    organizationSlug: 'northstar',
    messages: [],
  };
}

describe('57-10 Get help', () => {
  it('sends topic, priority, subject, message and the page the person came from', async () => {
    const posts: string[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      csrfCookieName: 'tm_session_csrf',
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        const post = init?.method === 'POST';
        if (post && typeof init.body === 'string') posts.push(init.body);
        const body =
          !post && String(input).endsWith('/support/threads')
            ? {
                threads: [],
                policy: { plan: 'studio', firstResponseMinutes: 360, timezone: 'Asia/Riyadh' },
              }
            : detail('Wrong VAT number');
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: post ? 201 : 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as typeof globalThis.fetch,
      readCsrfToken: () => undefined,
      newCorrelationId: () => 'c',
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <GetHelpScreen
          organizationSlug="northstar"
          organizationName="Northstar"
          from="/northstar/settings"
          client={client}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Studio plan/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'billing' } });
    fireEvent.change(screen.getByLabelText('How urgent is it?'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText(/Subject/u), { target: { value: 'Wrong VAT number' } });
    fireEvent.change(screen.getByLabelText('What’s happening?'), {
      target: { value: 'Our invoice shows the wrong VAT number.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0] ?? '{}')).toMatchObject({
      category: 'billing',
      priority: 'high',
      subject: 'Wrong VAT number',
      contextPath: '/northstar/settings',
      attachmentFileId: null,
    });
    expect(await screen.findByRole('heading', { name: 'Wrong VAT number' })).toBeTruthy();
  });

  it('words the response clock the API computes, in business time', () => {
    const clock = (over: Partial<NonNullable<SupportThread['sla']>['firstResponse']>) => ({
      status: 'open' as const,
      sla: {
        paused: false,
        breached: over.breached ?? false,
        firstResponse: {
          targetMinutes: 360,
          elapsedMinutes: 225,
          dueAt: '2026-11-15T12:30:00.000Z',
          respondedAt: null,
          breached: false,
          ...over,
        },
        resolution: {
          targetMinutes: 2700,
          elapsedMinutes: 0,
          dueAt: null,
          resolvedAt: null,
          breached: false,
        },
      },
    });
    expect(slaSummary(clock({}))).toMatchObject({ kind: 'due', minutes: 135, soon: false });
    expect(slaSummary(clock({ elapsedMinutes: 385, breached: true }))).toMatchObject({
      kind: 'late',
      minutes: 25,
    });
    expect(
      slaSummary(clock({ elapsedMinutes: 65, respondedAt: '2026-11-15T10:05:00.000Z' })),
    ).toMatchObject({ kind: 'answered', minutes: 65 });
    expect(formatBusinessDuration(135, UNITS)).toBe('2 h 15 min');
    expect(formatBusinessDuration(65, UNITS)).toBe('1 h 05 min');
    expect(formatBusinessDuration(25, UNITS)).toBe('25 min');
    expect(formatBusinessDuration(780, UNITS)).toBe('1 day 4 h');
  });
});
