import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { MaintenanceBanner } from '../src/components/screens/MaintenanceBanner';
import type { MaintenanceWindowView } from '../src/lib/api/maintenance';
import { expectNoAxeViolations } from './axe';

/**
 * **Platform maintenance banner (x185).**
 *
 * The write boundary (`org.manage`, severity/time validation, no write on a bad body) is proved over
 * the controller in `apps/api/src/modules/platform/maintenance.controller.test.ts`; nothing here
 * re-proves it. What only this file can prove is what the *banner* does with the public read: it
 * shows an accessible region only when a window is currently active, shows nothing otherwise, and is
 * dismissible for the session. The `initialWindow` seam feeds the view directly so there is no fetch.
 */

const ACTIVE: MaintenanceWindowView = {
  id: '0199aa00-0000-7000-8000-0000000000f0',
  message: 'Upgrading the database; some features are read-only.',
  severity: 'degraded',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2999-01-01T00:00:00.000Z',
  active: true,
};

afterEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});

describe('MaintenanceBanner', () => {
  it('shows an accessible banner when a window is active', async () => {
    const { container } = render(<MaintenanceBanner initialWindow={ACTIVE} />);
    const region = screen.getByRole('region', { name: 'Platform status' });
    expect(region).toHaveTextContent('Degraded service');
    expect(region).toHaveTextContent('Upgrading the database; some features are read-only.');
    await expectNoAxeViolations(container);
  });

  it('renders nothing when there is no active window', () => {
    const { container } = render(<MaintenanceBanner initialWindow={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the returned window is not active', () => {
    const { container } = render(
      <MaintenanceBanner initialWindow={{ ...ACTIVE, active: false }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('dismisses for the session when the reader dismisses it', async () => {
    const user = userEvent.setup();
    render(<MaintenanceBanner initialWindow={ACTIVE} />);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Platform status' })).not.toBeInTheDocument();
  });
});
