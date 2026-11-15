import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecurityPage } from '../src/components/website/pages/security/SecurityPage';
import { activeLocale } from '../src/lib/i18n/locale-store';

vi.mock('next/navigation', () => ({ usePathname: () => '/security', useRouter: () => ({}) }));
afterEach(() => (cleanup(), act(() => activeLocale.set('en-US'))));

/** Row 56-20 — the trust centre renders in both languages and claims no certification. */
describe('security page and trust centre', () => {
  it.each([
    ['en-US', 'How we keep your work safe'],
    ['ar-EG', 'كيف نحمي عملك'],
  ] as const)('renders %s with only the negated SOC 2 line', (loc, title) => {
    act(() => activeLocale.set(loc));
    const { container } = render(<SecurityPage />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
    const soc2 = screen.getByTestId('security-claim-soc2');
    expect(soc2.dataset['status']).toBe('not_audited');
    const rest = (container.textContent ?? '').replace(soc2.textContent ?? '', '');
    expect(rest).not.toMatch(/certified|SOC 2 compliant|ISO 27001|حاصل(?:ون|ين) على شهادة/iu);
    expect(container.textContent).not.toMatch(/SOC 2 compliant/i);
  });
});
