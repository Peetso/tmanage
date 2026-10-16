import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MobilePrimaryNav } from '../src/components/shell/MobilePrimaryNav';
import { INTERNAL_NAVIGATION, MOBILE_PRIMARY_NAVIGATION } from '../src/components/shell/navigation';
import { expectNoAxeViolations } from './axe';

/**
 * Module 23's five-item primary bottom navigation.
 *
 * Two guarantees the brief names: the set is exactly five destinations that the rail already
 * owns (so no route is invented), and the active state lands on exactly one of them.
 */
describe('mobile primary navigation', () => {
  it('is exactly five destinations, each a real internal rail destination', () => {
    expect(MOBILE_PRIMARY_NAVIGATION).toHaveLength(5);
    const internalIds = new Set(INTERNAL_NAVIGATION.map((item) => item.id));
    for (const item of MOBILE_PRIMARY_NAVIGATION) {
      expect(internalIds.has(item.id)).toBe(true);
      // The same object the rail carries — label, href suffix and glyph are not re-specified.
      expect(INTERNAL_NAVIGATION).toContain(item);
    }
    // The four the brief fixes, in order, with the fifth as the single swappable slot.
    expect(MOBILE_PRIMARY_NAVIGATION.slice(0, 4).map((item) => item.id)).toEqual([
      'home',
      'inbox',
      'chat',
      'work',
    ]);
  });

  it('renders each destination as a real link under the organization slug', () => {
    render(<MobilePrimaryNav organizationSlug="northstar" activeNavigationId="work" />);
    const nav = screen.getByRole('navigation', { name: 'Primary mobile' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(5);
    for (const item of MOBILE_PRIMARY_NAVIGATION) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute(
        'href',
        `/northstar${item.href}`,
      );
    }
  });

  it('marks exactly one destination current, in a word not only a colour', () => {
    render(<MobilePrimaryNav organizationSlug="northstar" activeNavigationId="work" />);
    const nav = screen.getByRole('navigation', { name: 'Primary mobile' });
    const current = within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('Work');
  });

  it('marks nothing current when the active destination is not in the five', () => {
    // `docs` is a rail destination that the dock does not carry; no item is then current.
    render(<MobilePrimaryNav organizationSlug="northstar" activeNavigationId="docs" />);
    const nav = screen.getByRole('navigation', { name: 'Primary mobile' });
    const current = within(nav)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(0);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <MobilePrimaryNav organizationSlug="northstar" activeNavigationId="home" />,
    );
    await expectNoAxeViolations(container);
  });
});
