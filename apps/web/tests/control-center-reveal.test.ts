import { describe, expect, it } from 'vitest';
import { revealInMenu } from '../src/components/admin/ControlCenterShell';

/** An element whose box is `top`..`top + height` on screen. */
function boxed(top: number, height: number): HTMLElement {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect;
  return element;
}

describe('revealInMenu', () => {
  it('scrolls the menu so an entry below its visible box sits in the middle', () => {
    const menu = boxed(64, 836);
    const billing = boxed(1500, 40);
    revealInMenu(billing, menu);
    // 1500 - 64 - (836 - 40) / 2: the entry's top lands 398 px into the menu's box.
    expect(menu.scrollTop).toBe(1038);
  });

  it('leaves the menu alone when the entry is already in view', () => {
    const menu = boxed(64, 836);
    revealInMenu(boxed(300, 40), menu);
    expect(menu.scrollTop).toBe(0);
  });
});
