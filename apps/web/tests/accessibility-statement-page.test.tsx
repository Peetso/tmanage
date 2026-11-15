import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessibilityStatementPage } from '../src/components/website/pages/accessibility/AccessibilityStatementPage';
import { FOOTER_COLUMNS } from '../src/components/website/site-nav';
import { activeLocale } from '../src/lib/i18n/locale-store';

vi.mock('next/navigation', () => ({ usePathname: () => '/accessibility', useRouter: () => ({}) }));
afterEach(() => (cleanup(), act(() => activeLocale.set('en-US'))));

/** The accessibility statement: both languages, WCAG only as a target, and a real feedback link. */
describe('accessibility statement page', () => {
  it.each([
    ['en-US', 'TManage should work for everyone'],
    ['ar-EG', 'TManage لكل الناس'],
  ] as const)('renders %s with WCAG as an unaudited target', (loc, title) => {
    act(() => activeLocale.set(loc));
    const { container } = render(<AccessibilityStatementPage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
    expect(screen.getByTestId('a11y-claim-wcag').dataset['status']).toBe('not_audited');
    expect(container.textContent).not.toMatch(/fully (compliant|accessible)|WCAG[^.]*conform/iu);
    const mail = container.querySelectorAll('a[href="mailto:tm-support@peetrix.com"]');
    expect(mail.length).toBeGreaterThan(0);
  });

  it('is where the footer accessibility link goes', () => {
    const links = FOOTER_COLUMNS.flatMap((group) => group.links);
    expect(links.find((link) => link.label === 'SiteNav.accessibility')?.href).toBe(
      '/accessibility',
    );
  });
});
