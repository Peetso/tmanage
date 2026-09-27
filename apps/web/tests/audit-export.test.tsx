import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuditExportScreen } from '../src/components/screens/AuditExportScreen';
import { expectNoAxeViolations } from './axe';

/** ADM-09 filtered export (x197) — the date-windowed audit CSV export screen. */
function mount() {
  return render(
    <AuditExportScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      baseUrl="https://api.example.test"
    />,
  );
}

describe('AuditExportScreen', () => {
  it('renders the labelled filter form and is accessible', async () => {
    const { container } = mount();
    expect(screen.getByLabelText(/^From/)).toBeTruthy();
    expect(screen.getByLabelText(/^To/)).toBeTruthy();
    expect(screen.getByLabelText('Actor ID')).toBeTruthy();
    expect(screen.getByLabelText('Action')).toBeTruthy();
    // No link until a window is chosen.
    expect(screen.queryByRole('link', { name: 'Export CSV' })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it('builds a download link to export.csv carrying the window and filters once a window is chosen', () => {
    mount();
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: '2026-03-31' } });
    fireEvent.change(screen.getByLabelText('Actor ID'), { target: { value: 'user-aaa' } });
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
