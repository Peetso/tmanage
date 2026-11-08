import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MobilePrimaryNav } from '../src/components/shell/MobilePrimaryNav';
import { PhoneHeaderActions } from '../src/components/shell/PhoneHeaderActions';

describe('phone shell (Figma 405:6575)', () => {
  it('draws a 24px line icon in every tab, a + icon on capture, and a bell to notifications', () => {
    render(<MobilePrimaryNav organizationSlug="northstar" />);
    const nav = screen.getByRole('navigation', { name: 'Primary mobile' });
    const icons = [...nav.querySelectorAll('svg.tm-phone-icon')].map((svg) =>
      svg.getAttribute('data-icon'),
    );
    // R38 G3: the tabs draw the icon that means the page (My Day is a sun, Work a checked box).
    expect(icons).toEqual(['sun', 'inbox', 'messages', 'squareCheck', 'more']);
    const capture = screen.getByRole('link', { name: 'Quick capture' });
    expect(capture.querySelector('svg')).toHaveAttribute('data-icon', 'plus');
    render(<PhoneHeaderActions organizationSlug="northstar" initials="OA" />);
    const bell = screen.getByRole('link', { name: 'Notifications' });
    expect(bell).toHaveAttribute('href', '/northstar/notifications');
    expect(within(bell).queryByText(/./)).toBeNull();
  });
});
