import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AdminAuditScreen } from '../src/components/screens/AdminAuditScreen';
import { expectNoAxeViolations } from './axe';

/** ADM audit viewer (x115) — the Administration audit-log screen over `GET .../audit/events`. */
function mount(body: unknown, status = 200, changes?: unknown) {
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            changes !== undefined && String(input).endsWith('/changes') ? changes : body,
          ),
          { status, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof globalThis.fetch,
    readCsrfToken: () => undefined,
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <AdminAuditScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        client={client}
      />
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
      result: 'allowed',
      summary: 'Created a project',
    },
    {
      id: 'audit-2',
      occurredAt: '2026-02-01T10:00:00.000Z',
      actorId: null,
      action: 'membership.revoked',
      entityType: 'membership',
      entityId: null,
      result: 'denied',
      summary: 'Removed a member (refused)',
    },
  ],
};

describe('AdminAuditScreen', () => {
  it('renders the filter form and a row per event, and is accessible', async () => {
    const { container } = mount(EVENTS);

    // TXT-03: the row shows the plain summary, not a raw action code.
    expect(await screen.findByText('Created a project')).toBeTruthy();
    // A lone refusal is not grouped, so its summary still shows.
    expect(screen.getByText('Removed a member (refused)')).toBeTruthy();
    // A system-initiated event shows "System" rather than a raw id or an empty actor cell.
    expect(screen.getByText('System')).toBeTruthy();
    // 2026-10-31 live test: the filter picks a person by name, never a raw actor/entity id.
    expect(screen.getByLabelText('Person')).toBeTruthy();
    expect(screen.queryByLabelText('Actor ID')).toBeNull();
    expect(screen.queryByLabelText('Entity ID')).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show everyone' })).toBeTruthy();
    // Exactly one h1 (the shell title) and no axe violation jsdom can detect.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it('renders the CSV export control as a download link to the export route (ADM-09)', async () => {
    mount(EVENTS);

    const exportLink = await screen.findByRole('link', { name: 'Export CSV' });
    // A download link, not a button: the browser fetches the CSV and the API forces the save.
    expect(exportLink.getAttribute('download')).toBe('audit-events.csv');
    expect(exportLink.getAttribute('href')).toContain(
      '/v1/organizations/northstar/audit/events/export',
    );
  });

  it('shows the empty state when the trail has no matching events', async () => {
    mount({ events: [] });
    expect(await screen.findByText('No audit events match this view.')).toBeTruthy();
  });

  it('names the fields and coded values of what changed (live check 0186c261 B7)', async () => {
    mount(
      {
        events: [
          {
            id: 'audit-3',
            occurredAt: '2026-11-10T03:00:00.000Z',
            actorId: null,
            action: 'organization.auto_time_tracking_policy_changed',
            entityType: 'organization',
            entityId: 'org-1',
            result: 'allowed',
            summary: 'Changed automatic time tracking',
          },
        ],
      },
      200,
      {
        changes: [
          { field: 'auto_time_tracking', before: 'optional', after: 'off', redacted: false },
          { field: 'max_idle_minutes', before: '5', after: '5', redacted: false },
          { field: 'open_auto_sessions', before: '2', after: '0', redacted: false },
        ],
      },
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Changed automatic time tracking' }));

    const list = await screen.findByTestId('audit-changes');
    expect(list.textContent).toContain('Automatic time tracking');
    expect(list.textContent).toContain('Before: Each person chooses');
    expect(list.textContent).toContain('After: Off');
    expect(list.textContent).toContain('Count someone as away after (minutes)');
    expect(list.textContent).toContain('Automatic sessions still open');
    expect(list.textContent).toContain('After: 0');
    expect(list.textContent).not.toContain('optional');
  });

  it('renders the API refusal rather than a blank page', async () => {
    mount({ error: { code: 'forbidden', message: 'No access.', correlationId: 'c' } }, 403);
    await waitFor(() => expect(screen.getByText('No access.')).toBeTruthy());
  });
});
