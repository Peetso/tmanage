/**
 * R12 / R2 — who decided the tab's language: the first-visit guess (`auto`) or a person (`chosen`).
 *
 * The guess (`locale-hint.ts`) only ever fills an empty slot: it runs when nothing is saved, and a
 * saved `chosen` is never overwritten by it. Every picker, the Preferences screen and an `/ar` link
 * write `chosen` through `LocaleStore.set`. Per-browser, like the locale cache itself; a read that
 * throws (private mode, blocked storage) reads as "no source".
 */

export const LOCALE_SOURCE_KEY = 'tmanage:locale-source';

export type LocaleSource = 'auto' | 'chosen';

export function readLocaleSource(): LocaleSource | undefined {
  if (typeof globalThis.localStorage === 'undefined') return undefined;
  try {
    const value = globalThis.localStorage.getItem(LOCALE_SOURCE_KEY);
    return value === 'auto' || value === 'chosen' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeLocaleSource(source: LocaleSource): void {
  if (typeof globalThis.localStorage === 'undefined') return;
  try {
    globalThis.localStorage.setItem(LOCALE_SOURCE_KEY, source);
  } catch {
    // Storage refused: the guess may run again next visit, which only re-offers the same toast.
  }
}
