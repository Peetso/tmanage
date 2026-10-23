import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MobilePrimaryNav } from '../src/components/shell/MobilePrimaryNav';
import {
  INTERNAL_NAVIGATION,
  MOBILE_DESTINATIONS,
  MOBILE_PRIMARY_NAVIGATION,
  MORE_TOOLS_NAVIGATION,
  MORE_WORKSPACE_NAVIGATION,
} from '../src/components/shell/navigation';
import { expectNoAxeViolations } from './axe';

/**
 * The phone tab bar (Figma ph-tabbar) and the More sheet it opens (ph-more).
 *
 * The guarantees: five slots — four real rail destinations and More — the inbox badge, the
 * quick-capture orb, and a More sheet whose every tile is a real link and which Escape closes.
 */
describe('mobile primary navigation', () => {
  it('is My Day, Inbox, Chat, Work and More, the four destinations being rail destinations', () => {
    expect(MOBILE_PRIMARY_NAVIGATION.map((item) => item.label)).toEqual([
      'My Day',
      'Inbox',
      'Chat',
      'Work',
      'More',
    ]);
    for (const item of MOBILE_DESTINATIONS) expect(INTERNAL_NAVIGATION).toContain(item);
  });

  it('renders four destination links under the slug, the More button and the capture orb', () => {
    render(<MobilePrimaryNav organizationSlug="northstar" activeNavigationId="work" />);
    const nav = screen.getByRole('navigation', { name: 'Primary mobile' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(4);
    for (const item of MOBILE_DESTINATIONS) {
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute(
        'href',
        `/northstar${item.href}`,
      );
    }
    expect(within(nav).getByRole('button', { name: 'More' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('link', { name: 'Quick capture' })).toHaveAttribute(
      'href',
      '/northstar/capture',
    );
    const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName('Work');
  });

  it('draws the inbox badge and describes it without renaming the link', () => {
    render(<MobilePrimaryNav organizationSlug="northstar" inboxUnreadCount={3} />);
    const inbox = screen.getByRole('link', { name: 'Inbox' });
    expect(within(inbox).getByText('3')).toBeInTheDocument();
    expect(inbox).toHaveAccessibleDescription('3 unread');
  });

  it('opens the More sheet with every tile a real link, and Escape closes it', () => {
    render(
      <MobilePrimaryNav organizationSlug="northstar" activeNavigationId="home" requestsCount={2} />,
    );
    const more = screen.getByRole('button', { name: 'More' });
    fireEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const sheet = screen.getByRole('dialog', { name: 'More' });
    expect(within(sheet).getByRole('button', { name: 'Done' })).toHaveFocus();
    for (const item of [...MORE_WORKSPACE_NAVIGATION, ...MORE_TOOLS_NAVIGATION]) {
      expect(within(sheet).getByRole('link', { name: item.label })).toHaveAttribute(
        'href',
        item.absolute ? item.href : `/northstar${item.href}`,
      );
    }
    expect(within(sheet).getByRole('link', { name: 'Requests' })).toHaveAccessibleDescription(
      '2 waiting',
    );
    // While the sheet is open the More orb is the inked one, not My Day.
    expect(screen.getByRole('link', { name: 'My Day' })).not.toHaveAttribute('aria-current');

    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more).toHaveFocus();
  });

  it('keeps Tab inside the open sheet', () => {
    render(<MobilePrimaryNav organizationSlug="northstar" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const sheet = screen.getByRole('dialog', { name: 'More' });
    const last = within(sheet).getByRole('link', { name: 'Help' });
    last.focus();
    fireEvent.keyDown(sheet, { key: 'Tab' });
    expect(within(sheet).getByRole('button', { name: 'Done' })).toHaveFocus();
  });

  it('has no axe violations, closed or open', async () => {
    const { container } = render(
      <MobilePrimaryNav organizationSlug="northstar" activeNavigationId="home" />,
    );
    await expectNoAxeViolations(container);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    await expectNoAxeViolations(container);
  });
});
