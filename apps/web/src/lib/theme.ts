import type { DisplayDensity, DisplayTheme } from './api/display-preferences';
import { writeThemeCookie } from './theme-cookie';

/**
 * PREF-02's theme, applied. The member's saved theme (`light` / `dark` / `system`) becomes
 * `<html data-theme>`, which every token in `packages/ui/src/styles/tokens.css` keys on. It is
 * cached in `localStorage` so `localeBootScript()` can set it before the first paint and a
 * dark-mode reload does not flash white.
 */
export const THEME_STORAGE_KEY = 'tmanage.theme';

let systemListener: ((event: MediaQueryListEvent) => void) | null = null;

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

export function resolveTheme(theme: DisplayTheme, prefersDark: boolean): 'light' | 'dark' {
  if (theme === 'system') return prefersDark ? 'dark' : 'light';
  return theme;
}

export function applyTheme(theme: DisplayTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset['theme'] = resolveTheme(theme, systemPrefersDark());
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the theme still applies for this page.
  }
  // B17: the cookie lets a dynamic server render put this theme in the first HTML.
  writeThemeCookie(theme);
  if (typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  if (systemListener) query.removeEventListener('change', systemListener);
  systemListener = null;
  if (theme === 'system') {
    systemListener = (event) => {
      root.dataset['theme'] = event.matches ? 'dark' : 'light';
    };
    query.addEventListener('change', systemListener);
  }
}

/**
 * The member's density, applied. `<html data-density>` drives the design system's row, control
 * and radius tokens (`tokens.css`): Comfortable is the system's `balanced` step and Compact its
 * `operational` step, the tighter one PREF-02 says fits more rows on a work list.
 */
export function densityAttribute(density: DisplayDensity): 'balanced' | 'operational' {
  return density === 'compact' ? 'operational' : 'balanced';
}

export function applyDensity(density: DisplayDensity): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset['density'] = densityAttribute(density);
}
