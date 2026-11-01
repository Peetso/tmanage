import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MeetingsScreen } from '../src/components/screens/MeetingsScreen';
import { ApiClient } from '../src/lib/api/client';
import { expectNoAxeViolations } from './axe';

/**
 * All meetings (approved Figma 415:19974). Proves what only the screen does: it reads one
 * org-wide window (no projectId), draws each meeting in the week linking to its meeting page,
 * shows the empty "connect your calendar" state when nothing is planned or connected, and stays
 * axe-clean (A11Y-01).
 */

const NOW = new Date(2026, 9, 28, 8, 0);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mount(meetings: readonly unknown[], connected: boolean) {
  const urls: string[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/meetings?from=')) return Promise.resolve(json({ meetings }));
      if (url.includes('/integrations/microsoft-calendar')) return Promise.resolve(json({}, 404));
      if (url.includes('/integrations/google-calendar')) {
        return Promise.resolve(
          json({
            configured: true,
            google: {
              status: connected ? 'connected' : 'not_connected',
              accountEmail: connected ? 'sam@acme.test' : null,
              connectedAt: null,
              lastSyncedAt: null,
              lastErrorCode: null,
            },
          }),
        );
      }
      if (url.includes('/projects')) return Promise.resolve(json({ projects: [] }));
      return Promise.resolve(json({}, 404));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queries}>
      <MeetingsScreen organizationSlug="acme" organizationName="Acme" client={client} now={NOW} />
    </QueryClientProvider>,
  );
  return { urls, container: view.container };
}

describe('MeetingsScreen', () => {
  it('reads one org-wide week and links each meeting to its page', async () => {
    const meeting = {
      id: 'meeting-1',
      projectId: 'project-1',
      title: 'Kickoff',
      startsAt: new Date(2026, 9, 28, 10, 0).toISOString(),
      endsAt: new Date(2026, 9, 28, 11, 0).toISOString(),
      agendaNote: null,
      createdByUserId: 'user-1',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const { urls, container } = mount([meeting], true);
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('link')
          .some((a) => a.getAttribute('href') === '/acme/calendar/meetings/meeting-1'),
      ).toBe(true),
    );
    expect(urls.some((u) => u.includes('/meetings?from=') && !u.includes('projectId'))).toBe(true);
    await expectNoAxeViolations(container);
  });

  it('offers to connect a calendar when nothing is planned or connected', async () => {
    mount([], false);
    expect(
      await screen.findByText('Connect your calendar to send invitations and video links.'),
    ).toBeTruthy();
    // Figma 419:23431: no "owner hasn't switched on calendars" message for anyone.
    expect(screen.getByText('Not ready to connect?')).toBeTruthy();
    expect(screen.queryByText(/workspace owner/i)).toBeNull();
    // Figma 446:34834 (2026-10-31 live-test fix): the views, Past and the dates stay usable.
    expect(screen.getByRole('button', { name: 'Month' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Past' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Today' })).toBeTruthy();
  });
});
