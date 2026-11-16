import { expect, it } from 'vitest';
import { applyA11yPreferences } from '../src/lib/a11y-shell';
import { localeBootScript } from '../src/lib/i18n/locale-boot';

it('a fresh load of any page applies the saved text size and contrast without the settings screen', () => {
  applyA11yPreferences({ fontScale: 'xl', reduceMotion: true, highContrast: true });
  const root = document.documentElement;
  for (const name of ['data-tm-font-scale', 'data-tm-reduce-motion', 'data-tm-high-contrast'])
    root.removeAttribute(name);
  new Function(localeBootScript())();
  expect(root.getAttribute('data-tm-font-scale')).toBe('xl');
  expect(root.getAttribute('data-tm-reduce-motion')).toBe('on');
  expect(root.getAttribute('data-tm-high-contrast')).toBe('on');
});
