import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkListScreen } from '../src/components/screens/WorkListScreen';
import { ApiClient } from '../src/lib/api/client';
import ar from '../src/lib/i18n/messages/ar.json';
import { activeLocale, DEFAULT_LOCALE } from '../src/lib/i18n/locale-store';
import { expectNoAxeViolations } from './axe';

/**
 * ACT-11 / NFR-02 (lane C8): under Arabic, the work list said "Blocked" in the state capsule of
 * every blocked row although the filter chip above it was already Arabic. Both now come from the
 * same catalog key, and the Arabic screen still has no axe violation.
 */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function clientFor(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes('/work-items')
          ? json({ workItems: [BLOCKED_ITEM] })
          : json({ projects: [PROJECT] }),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const BLOCKED_ITEM = {
  id: 'wi-9',
  projectId: 'proj-1',
  type: 'task',
  title: 'روابط التذييل',
  state: 'blocked',
  ownerUserId: null,
  audience: 'internal',
  startAt: null,
  dueAt: null,
  completedAt: null,
  version: 1,
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  deletedAt: null,
};

const PROJECT = {
  id: 'proj-1',
  name: 'Website redesign',
  status: 'active',
  ownerUserId: 'user-1',
  committedAt: null,
  forecastAt: '2026-09-30T00:00:00.000Z',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z',
  archivedAt: null,
};

afterEach(() => {
  act(() => activeLocale.set(DEFAULT_LOCALE));
});

describe('work list in Arabic (ACT-11)', () => {
  it('names a blocked row and the Blocked filter with the same Arabic word, axe-clean', async () => {
    act(() => activeLocale.set('ar-EG'));
    const blocked = ar['WorkListScreen.stateBlocked'];

    const { container } = render(
      withQuery(
        <WorkListScreen
          organizationSlug="northstar"
          organizationName="Northstar Studio"
          client={clientFor()}
          now={new Date('2026-09-01T12:00:00.000Z')}
        />,
      ),
    );

    const row = await screen.findByRole('row', { name: new RegExp(BLOCKED_ITEM.title) });
    expect(within(row).getByText(blocked)).toBeInTheDocument();
    expect(within(row).queryByText('Blocked')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: blocked })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Blocked' })).not.toBeInTheDocument();
    // C1: the type cell reads the Arabic type word, the caption uses the Arabic comma.
    expect(within(row).getByText(ar['WorkItemType.task'])).toBeInTheDocument();
    expect(within(row).queryByText('TSK')).not.toBeInTheDocument();
    expect(container.querySelector('caption')?.textContent).toMatch(/، ١ /);

    await expectNoAxeViolations(container);
  });
});
