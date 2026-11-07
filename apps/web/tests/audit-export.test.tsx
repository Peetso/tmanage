import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api/client';
import { AuditExportScreen } from '../src/components/screens/AuditExportScreen';
import { expectNoAxeViolations } from './axe';

/** ADM-09 filtered export (x197) — the date-windowed audit CSV export screen. */
const MEMBERS = {
  members: [{ userId: 'user-aaa', displayName: 'Omar Haddad', role: 'owner', status: 'active' }],
  nextAfter: null,
};

function mount() {
  const fetchImpl = (() =>
    Promise.resolve(
      new Response(JSON.stringify(MEMBERS), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )) as typeof globalThis.fetch;
  const client = new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: fetchImpl,
    readCsrfToken: () => 'csrf',
    newCorrelationId: () => 'c',
  });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={query}>
      <AuditExportScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        baseUrl="https://api.example.test"
        client={client}
      />
    </QueryClientProvider>,
  );
}

describe('AuditExportScreen', () => {
  it('renders the labelled filter form and is accessible', async () => {
    const { container } = mount();
    expect(screen.getByLabelText(/^From/)).toBeTruthy();
    expect(screen.getByLabelText(/^To/)).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Person' })).toBeTruthy();
    expect(screen.getByLabelText('Action')).toBeTruthy();
    // No link until a window is chosen.
    expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it('builds a download link to export.csv carrying the window and filters once a window is chosen', async () => {
    mount();
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-03-31' } });
    // C18: the actor is picked by name; the export still carries the member's id.
    await userEvent.type(screen.getByRole('combobox', { name: 'Person' }), 'Omar');
    await userEvent.click(await screen.findByRole('option', { name: /Omar Haddad/ }));
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'membership.revoked' } });

    const link = screen.getByRole('link', { name: 'Export CSV' });
    expect(link.getAttribute('download')).toBe('audit-export.csv');
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('/v1/organizations/northstar/audit/export.csv?');
    expect(href).toContain('from=2026-03-01T00%3A00%3A00.000Z');
    expect(href).toContain('to=2026-03-31T23%3A59%3A59.999Z');
    expect(href).toContain('actor=user-aaa');
    expect(href).toContain('action=membership.revoked');
  });

  it('refuses to offer the link and says why for an inverted window', () => {
    mount();
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-04-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-03-01' } });
    expect(screen.getByText(/must not be earlier/i)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull();
  });
});
