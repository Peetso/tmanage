import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InsightsExportButton } from '../src/components/screens/InsightsExportButton';
import { expectNoAxeViolations } from './axe';

/**
 * INS-05 — the workload CSV export control. The download URL and the server's `work.read` gating
 * are proven on the API side; this proves the one thing the control owns — that it renders an
 * accessible link to the export endpoint. `baseUrl` is injected so the render needs no
 * `NEXT_PUBLIC_*` environment.
 */
describe('InsightsExportButton', () => {
  it('renders an accessible link to the workload export endpoint', async () => {
    const { container } = render(
      <main>
        <InsightsExportButton organizationSlug="northstar" baseUrl="https://api.example.test" />
      </main>,
    );

    const link = screen.getByRole('link', { name: /export workload \(csv\)/i });
    expect(link.getAttribute('href')).toBe(
      'https://api.example.test/v1/organizations/northstar/insights/workload/export.csv',
    );

    await expectNoAxeViolations(container);
  });
});
