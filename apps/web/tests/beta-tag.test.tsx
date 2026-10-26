import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { BetaTag } from '../src/components/shell/BetaTag';
import { AppShell } from '../src/components/shell/AppShell';
import { ControlCenterShell } from '../src/components/admin/ControlCenterShell';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('Beta tag beside the logo (Figma 419:9992)', () => {
  it('reads BETA in English and تجريبي in Arabic', () => {
    const { unmount } = render(<BetaTag placement="topbar" />);
    expect(screen.getByText('BETA')).toHaveClass('tm-beta-tag');
    unmount();
    act(() => activeLocale.set('ar-EG'));
    render(<BetaTag placement="topbar" />);
    expect(screen.getByText('تجريبي')).toHaveAttribute('data-placement', 'topbar');
  });

  it('sits with the rail logo on desktop and leads the phone top bar', () => {
    render(
      <AppShell organizationSlug="northstar" organizationName="Northstar Studio" title="My day">
        <p>Body</p>
      </AppShell>,
    );
    const rail = screen.getByRole('navigation', { name: 'Primary' });
    const brand = within(rail).getByRole('link', { name: /home/i });
    expect(brand.nextElementSibling).toHaveClass('tm-beta-tag');
    expect(brand.nextElementSibling).toHaveAttribute('data-placement', 'rail');
    const header = document.querySelector('.tm-canvas-header__context');
    expect(header?.firstElementChild).toHaveAttribute('data-placement', 'phone');
    expect(header?.firstElementChild).toHaveTextContent('BETA');
  });

  it('sits between the logo and the breadcrumb in the Control Center top bar', () => {
    render(
      <ControlCenterShell
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        section="billing"
        crumbs={['Billing']}
        title="Billing"
      >
        <p>Body</p>
      </ControlCenterShell>,
    );
    const brand = document.querySelector('.tm-cc-topbar__brand');
    expect(brand?.nextElementSibling).toHaveClass('tm-beta-tag');
    expect(brand?.nextElementSibling).toHaveTextContent('BETA');
    expect(brand?.nextElementSibling?.nextElementSibling).toHaveClass('tm-cc-topbar__trail');
  });
});
