import { useCallback, useSyncExternalStore } from 'react';

/**
 * The viewport breakpoint below which the shell swaps the orbital rail for the mobile dock
 * (`globals.css`, Module 23). Expressed in `rem` so the JS branch and the CSS `@media` rule agree
 * on the same line: `47.99rem` is ~768px, the boundary `MobilePrimaryNav` already keys off.
 */
export const MOBILE_MEDIA_QUERY = '(max-width: 47.99rem)';

/**
 * Whether the viewport is at mobile width — a small, SSR-safe `matchMedia` hook (Module 23's
 * "planning-heavy views transform to summaries"). A screen branches on it to show a compact
 * read-only summary in place of its dense grid below the breakpoint, and the full view everywhere
 * else.
 *
 * `useSyncExternalStore` is used for the same reason `useHydrated` gives: it reads a different value
 * on the server (`false`) than on the client without a flickering second render. The server and the
 * first client paint are therefore the full view — the desktop default — and the client re-renders
 * to the summary only if the live media query matches. `matchMedia` is guarded: where it is absent
 * (the server, and any environment that does not implement it, such as a bare jsdom) the hook
 * reports `false` and nothing subscribes.
 */
export function useIsMobile(query: string = MOBILE_MEDIA_QUERY): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const list = mediaQueryList(query);
      if (list === null) return () => {};
      list.addEventListener('change', onStoreChange);
      return () => list.removeEventListener('change', onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback((): boolean => mediaQueryList(query)?.matches ?? false, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The media query result, or `null` where `matchMedia` is unavailable (the server, bare jsdom). */
function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(query);
}

/** The server never has a viewport, so the server snapshot is always the desktop default. */
const getServerSnapshot = (): boolean => false;
