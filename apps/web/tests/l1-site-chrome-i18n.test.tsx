import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleDirectionProvider } from '../src/components/providers/LocaleDirectionProvider';
import { WebsiteChrome } from '../src/components/website/WebsiteChrome';
import { LanguageSwitch, isArabicLocale } from '../src/components/website/WebFooter';
import { FOOTER_COLUMNS, FOOTER_LEGAL, NAV_ACTIONS } from '../src/components/website/site-nav';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { translate, type MessageKey } from '../src/lib/i18n/t';

vi.mock('next/navigation', () => ({ usePathname: () => '/pricing' }));

/**
 * **L1 — shared site chrome follows the active locale (live check 014a9d51).**
 *
 * The header actions, nav, skip link and footer were a hard-coded English table, so an Arabic
 * page kept "Start free", "Skip to main content" and every footer heading in English, and the
 * language switch could look as if it marked the wrong language. Names come from the catalog,
 * so the test holds before and after the L1 fragment is merged into `en.json`/`ar.json`.
 */
const ar = (key: MessageKey) => translate('ar-EG', key);
const en = (key: MessageKey) => translate('en-US', key);

afterEach(() => {
  act(() => activeLocale.set('en-US'));
});

describe('LanguageSwitch', () => {
  it('marks English pressed on an English page', () => {
    act(() => activeLocale.set('en-US'));
    render(<LanguageSwitch />);
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'العربية' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('marks العربية pressed on an Arabic page', () => {
    act(() => activeLocale.set('ar-EG'));
    render(<LanguageSwitch />);
    expect(screen.getByRole('button', { name: 'العربية' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('a click flips the pressed state and the document direction together', async () => {
    const user = userEvent.setup();
    act(() => activeLocale.set('en-US'));
    render(
      <LocaleDirectionProvider>
        <LanguageSwitch />
      </LocaleDirectionProvider>,
    );
    expect(document.documentElement.dir).toBe('ltr');

    await user.click(screen.getByRole('button', { name: 'العربية' }));
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar-EG');
    expect(screen.getByRole('button', { name: 'العربية' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'English' }));
    expect(document.documentElement.dir).toBe('ltr');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers the same languages as a phone menu that shows and changes the current one', async () => {
    const user = userEvent.setup();
    act(() => activeLocale.set('fr-FR'));
    render(
      <LocaleDirectionProvider>
        <LanguageSwitch />
      </LocaleDirectionProvider>,
    );
    const menu = screen.getByRole('combobox');
    const row = screen.getByRole('group');
    expect(
      within(menu)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent),
    );
    expect(menu).toHaveValue('fr-FR');
    expect(within(row).getByRole('button', { name: 'Français' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.selectOptions(menu, 'ar-EG');
    expect(document.documentElement.dir).toBe('rtl');
    expect(menu).toHaveValue('ar-EG');
  });

  it('uses the same language rule as translate()', () => {
    expect(isArabicLocale('ar-EG')).toBe(true);
    expect(isArabicLocale('AR-eg')).toBe(true);
    expect(isArabicLocale('en-US')).toBe(false);
    expect(isArabicLocale('arn-CL')).toBe(false);
  });
});

describe('WebsiteChrome in Arabic', () => {
  it('renders the skip link, header actions and footer through the catalog', () => {
    act(() => activeLocale.set('ar-EG'));
    render(
      <WebsiteChrome>
        <p>content</p>
      </WebsiteChrome>,
    );

    expect(screen.getByRole('link', { name: ar('WebsiteChrome.skipLink') })).toHaveAttribute(
      'href',
      '#tm-web-main',
    );
    // Header and the (hidden until opened) mobile drawer both carry the actions.
    expect(
      screen.getAllByRole('link', { name: ar(NAV_ACTIONS.start.label), hidden: true }).length,
    ).toBe(2);
    expect(
      screen.getAllByRole('link', { name: ar(NAV_ACTIONS.signIn.label), hidden: true }).length,
    ).toBe(2);

    const footer = screen.getByRole('contentinfo');
    for (const column of FOOTER_COLUMNS) {
      expect(within(footer).getAllByText(ar(column.heading)).length).toBeGreaterThan(0);
    }
    for (const link of FOOTER_LEGAL) {
      expect(within(footer).getAllByRole('link', { name: ar(link.label) }).length).toBeGreaterThan(
        0,
      );
    }
  });

  it('keeps English in English', () => {
    act(() => activeLocale.set('en-US'));
    render(
      <WebsiteChrome>
        <p>content</p>
      </WebsiteChrome>,
    );
    expect(screen.getByRole('link', { name: en('WebsiteChrome.skipLink') })).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: en(NAV_ACTIONS.demo.label), hidden: true }).length,
    ).toBe(2);
  });
});
