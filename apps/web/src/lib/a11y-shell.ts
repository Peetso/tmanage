import { A11Y_FONT_SCALES, type A11yPreferencesView } from './api/a11y-preferences';

/**
 * x183's settings, applied. Font size, reduced motion and high contrast become
 * `data-tm-font-scale` / `data-tm-reduce-motion` / `data-tm-high-contrast` on `<html>` (the guarded
 * rules in `globals.css`). They are cached in `localStorage` under {@link A11Y_STORAGE_KEY}, so
 * `localeBootScript()` sets them before the first paint of every page, the portal included, and a
 * reload never shows the default size first. `ThemeSync` re-applies the saved row in the workspace.
 */
export const A11Y_STORAGE_KEY = 'tmanage.a11y';

/** True when the operating system asks for reduced motion, so the shell honours it even when unset. */
function systemPrefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Write the settings onto the document root and cache them for the next load. Reduced motion is the
 * OR of the saved setting and the OS `prefers-reduced-motion`.
 */
export function applyA11yPreferences(settings: A11yPreferencesView): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const fontScale = A11Y_FONT_SCALES.includes(settings.fontScale) ? settings.fontScale : 'md';
  root.setAttribute('data-tm-font-scale', fontScale);
  root.setAttribute(
    'data-tm-reduce-motion',
    settings.reduceMotion || systemPrefersReducedMotion() ? 'on' : 'off',
  );
  root.setAttribute('data-tm-high-contrast', settings.highContrast ? 'on' : 'off');
  try {
    window.localStorage.setItem(
      A11Y_STORAGE_KEY,
      JSON.stringify({
        fontScale,
        reduceMotion: settings.reduceMotion,
        highContrast: settings.highContrast,
      }),
    );
  } catch {
    // Private mode or blocked storage: the settings still apply for this page.
  }
}
