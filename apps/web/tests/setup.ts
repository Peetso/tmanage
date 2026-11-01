import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Testing Library's `findBy*` / `waitFor` give up after 1 s by default, while vitest's own
 * ceiling above is measured in tens of seconds — a gap the WORK-001 session hit once, named
 * in `docs/implementation-status.md`, and deliberately left "for a session that can decide
 * it on purpose". Decided on 2026-08-29, after the gap produced two more one-off failures in
 * `work-flow.test.tsx` under sixteen-worker contention (a `findByRole` and a `findAllByRole`
 * that pass alone every time): five seconds. What a passing test waits for still arrives in
 * milliseconds — this changes only how long a slow machine gets before an honest wait is
 * called a failure. A genuinely missing element now costs 5 s to report instead of 1 s,
 * which is the price and is worth naming.
 */
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  // The language switch saves the locale in a cookie as well as localStorage (locale-cookie.ts).
  // jsdom keeps one cookie jar per file, so clear it like the tests clear localStorage, or one
  // test's Arabic choice would decide the next test's boot locale.
  if (typeof document !== 'undefined') {
    document.cookie = 'tmanage_locale=; Path=/; Max-Age=0';
  }
});

// R5: jsdom has no layout. The rich document editor (ProseMirror, Tiptap's floating menus) asks
// for range rectangles, the element under a point and resize observers; answer with empty ones.
if (typeof window !== 'undefined') {
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects ??= () =>
    Object.assign([], { item: () => null }) as unknown as DOMRectList;
  document.elementFromPoint ??= () => null;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
