import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/shell/AppShell';
import { LocaleDirectionProvider } from '../src/components/providers/LocaleDirectionProvider';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { translate, type MessageKey } from '../src/lib/i18n/t';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const signOut = vi.fn<() => Promise<void>>();
vi.mock('../src/lib/api/session', () => ({ signOut: () => signOut() }));

/** Names come from the catalog, so the test holds before and after the P4 fragment is merged. */
const en = (key: string) => translate('en-US', `AccountMenu.${key}` as MessageKey);

function renderShell() {
  return render(
    <LocaleDirectionProvider>
      <AppShell
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        title="Work"
        accountName="Omar Adel"
        accountEmail="omar@northstar.studio"
      >
        <p>Canvas</p>
      </AppShell>
    </LocaleDirectionProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: en('trigger') }));
  return screen.getByRole('menu');
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
  push.mockReset();
  signOut.mockReset();
});

describe('AccountMenu (t2-a)', () => {
  it('opens from the avatar with the person and the design items, and Escape closes it', () => {
    renderShell();
    expect(screen.getByRole('button', { name: en('trigger') })).toHaveTextContent('OA');
    const menu = openMenu();
    expect(menu).toHaveTextContent('Omar Adel');
    expect(menu).toHaveTextContent('omar@northstar.studio');
    expect(screen.getByRole('menuitem', { name: en('profile') })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: en('profile') })).toHaveAttribute(
      'href',
      '/northstar/preferences',
    );
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('signs out through the session API and goes to sign-in', async () => {
    signOut.mockResolvedValue();
    renderShell();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: en('signOut') }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/sign-in'));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('flips the document to Arabic, right-to-left, from the language item', () => {
    renderShell();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: en('language') }));
    expect(document.documentElement.dir).toBe('rtl');
    expect(activeLocale.get()).toBe('ar-EG');
  });
});
