import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_NAVIGATION,
  CONTROL_CENTER_NAVIGATION,
  INTERNAL_NAVIGATION,
  MOBILE_MORE_ITEM,
  MORE_TOOLS_NAVIGATION,
  MORE_WORKSPACE_NAVIGATION,
} from '../src/components/shell/navigation';
import { PORTAL_MENU_ENTRIES } from '../src/components/shell/PortalMenu';
import { SECTION_ICONS } from '../src/components/admin/ControlCenterShell';
import { NavIcon, PHONE_ICON_NAMES, PhoneIcon } from '../src/components/icons/phone';

/** R38 G3: every menu entry draws an icon that means its page, from the one TManage line set. */
describe('menu icons', () => {
  it('gives every menu entry a real icon from the set, and each rail entry its own', () => {
    const names = new Set<string>(PHONE_ICON_NAMES);
    const used = [
      ...INTERNAL_NAVIGATION,
      CONTROL_CENTER_NAVIGATION,
      MOBILE_MORE_ITEM,
      ...MORE_WORKSPACE_NAVIGATION,
      ...MORE_TOOLS_NAVIGATION,
      ...CLIENT_NAVIGATION,
      ...PORTAL_MENU_ENTRIES,
    ].map((item) => item.icon);
    for (const icon of [...used, ...Object.values(SECTION_ICONS)]) expect(names).toContain(icon);
    const rail = [...INTERNAL_NAVIGATION, CONTROL_CENTER_NAVIGATION].map((item) => item.icon);
    expect(new Set(rail).size).toBe(rail.length);
  });

  it('draws the icon that names the page', () => {
    const rail = Object.fromEntries(INTERNAL_NAVIGATION.map((item) => [item.id, item.icon]));
    expect(rail).toMatchObject({
      home: 'sun',
      inbox: 'inbox',
      chat: 'messages',
      calendar: 'calendar',
      people: 'users',
      finance: 'receipt',
    });
    const tools = Object.fromEntries(MORE_TOOLS_NAVIGATION.map((item) => [item.id, item.icon]));
    expect(tools).toMatchObject({ search: 'search', settings: 'settings', help: 'help' });
    expect(SECTION_ICONS).toMatchObject({ security: 'shield', billing: 'creditCard' });
  });

  it('marks only directional menu icons for mirroring in Arabic', () => {
    const { container } = render(
      <>
        <NavIcon name="logOut" />
        <NavIcon name="settings" />
        <PhoneIcon name="back" />
      </>,
    );
    const [signOut, gear, phoneBack] = Array.from(container.querySelectorAll('svg'));
    expect(signOut).toHaveAttribute('data-mirror', 'rtl');
    expect(gear).not.toHaveAttribute('data-mirror');
    // Phone screens flip their own arrows; a second flip would point them back the wrong way.
    expect(phoneBack).not.toHaveAttribute('data-mirror');
    expect(gear).toHaveAttribute('aria-hidden', 'true');
  });
});
