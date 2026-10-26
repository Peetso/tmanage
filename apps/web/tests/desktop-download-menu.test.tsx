import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu } from '../src/components/shell/AccountMenu';
import { DESKTOP_INSTALLER_HREF } from '../src/lib/desktop-download';
import { translate, type MessageKey } from '../src/lib/i18n/t';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const en = (key: string) => translate('en-US', `AccountMenu.${key}` as MessageKey);
const shell = window as Window & { tmanageDesktop?: unknown };

function openMenu() {
  render(<AccountMenu organizationSlug="northstar" name="Mona Hassan" />);
  fireEvent.click(screen.getByRole('button', { name: en('trigger') }));
}

afterEach(() => {
  delete shell.tmanageDesktop;
});

describe('AccountMenu desktop download (Figma 412:6812)', () => {
  it('offers the installer in the browser and hides it inside the desktop app', () => {
    openMenu();
    expect(screen.getByRole('menuitem', { name: en('downloadDesktop') })).toHaveAttribute(
      'href',
      DESKTOP_INSTALLER_HREF,
    );
    fireEvent.click(screen.getByRole('button', { name: en('trigger') }));

    shell.tmanageDesktop = { readonly: true };
    fireEvent.click(screen.getByRole('button', { name: en('trigger') }));
    expect(screen.queryByRole('menuitem', { name: en('downloadDesktop') })).toBeNull();
  });
});
