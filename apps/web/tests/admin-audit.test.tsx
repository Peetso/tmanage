import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminAuditScreen } from '../src/components/screens/AdminAuditScreen';
import { expectNoAxeViolations } from './axe';

/** ADM audit viewer (x115) — the Administration audit-log screen over `GET .../audit/events`. */
function mount(body: unknown, status = 200) {
  const client = new ApiClient({
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
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <AdminAuditScreen organizationSlug="northstar" organizationName="Northstar Studio" client={client} />
    </QueryClientProvider>,
  );
}

const EVENTS = {
  events: [
    {
      id: 'audit-1',
      occurredAt: '2026-02-01T09:00:00.000Z',
      actorId: 'user-aaa',
      action: 'project.created',
      entityType: 'project',
      entityId: 'project-1',
      summary: 'project.created',
    },
    {
      id: 'audit-2',
      occurredAt: '2026-02-01T10:00:00.000Z',
      actorId: null,
      action: 'membership.revoked',
      entityType: 'membership',
      entityId: null,
      summary: 'membership.revoked (denied)',
    },
  ],
};

describe('AdminAuditScreen', () => {
  it('renders the filter form and a row per event, and is accessible', async () => {
    const { container } = mount(EVENTS);

    expect(await screen.findByText('project.created')).toBeTruthy();
    expect(screen.getByText('membership.revoked (denied)')).toBeTruthy();
    // A system-initiated event shows "system" rather than an empty actor cell.
    expect(screen.getByText('system')).toBeTruthy();
    // The filters are real, labelled form controls.
    expect(screen.getByLabelText('Actor ID')).toBeTruthy();
    expect(screen.getByLabelText('Entity ID')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply filters' })).toBeTruthy();
    // Exactly one h1 (the shell title) and no axe violation jsdom can detect.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it('shows the empty state when the trail has no matching events', async () => {
    mount({ events: [] });
    expect(await screen.findByText('No audit events match this view.')).toBeTruthy();
  });

  it('renders the API refusal rather than a blank page', async () => {
    mount({ error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } }, 403);
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });
});
