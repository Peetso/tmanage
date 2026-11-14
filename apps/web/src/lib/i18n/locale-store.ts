import { DISPLAY_LOCALES, type DisplayLocale } from '../api/display-preferences';
import { LOCALE_STORAGE_KEY, resolveBootLocale } from './locale-boot';
import { writeLocaleCookie } from './locale-cookie';
import { readLocaleSource, writeLocaleSource } from './locale-source';
import { requestDisplay } from './request-display';

/**
 * i18n (NFR-02, I18N-01) — the one place the tab's *active* locale lives.
 *
 * The saved locale is a per-studio server preference read over react-query, but `dir`/`lang`
 * and every `Intl` formatter are document-level facts the whole shell has to agree on at once.
 * So, exactly as `auth-boundary.ts` makes a change of principal one observable event, this makes
 * the active locale one observable value: the preferences screen publishes it here when it is
 * read or changed, and the things that must react — {@link LocaleDirectionProvider}, the
 * formatters, `t()` — subscribe here. No screen reaches into the DOM or re-reads the preference.
 *
 * The initial value is decided once, by the same rules as the inline `<head>` boot script
 * (`locale-boot.ts`): an allowlisted `?lang=` first (and persisted), then the saved-locale cookie
 * the server rendered with (`locale-cookie.ts`), then the locale cached in `localStorage`, then
 * the shipped default. Every change is saved in both, so the next load is rendered right. So a
 * reload, or a link carrying `?lang=ar`, paints the right direction before the preference query
 * resolves, and the store agrees with what the boot script already set on `<html>`. `localStorage` is a per-browser convenience here, never the
 * source of truth — the server preference is — so a read that throws (private mode, blocked
 * storage) simply yields the default. Nothing is stored that identifies the member.
 */

export const DEFAULT_LOCALE: DisplayLocale = 'en-US';

/** The key the active locale is cached under, for a flash-free reload. */
export { LOCALE_STORAGE_KEY };

const ALLOWED: ReadonlySet<string> = new Set(DISPLAY_LOCALES);

function isDisplayLocale(value: unknown): value is DisplayLocale {
  return typeof value === 'string' && ALLOWED.has(value);
}

export type LocaleListener = (locale: DisplayLocale) => void;

export class LocaleStore {
  private current: DisplayLocale;
  private readonly listeners = new Set<LocaleListener>();

  /**
   * R12 R2: true when the tab booted with nothing saved (no `?lang=`, cookie or cache) and no one
   * has picked a language since — the only state in which {@link applyHint} may act.
   */
  private open: boolean;

  /**
   * FIX6 locale flash: on the server the application store answers with the locale of the request
   * being rendered (`request-display.ts`), so text rendered outside a hook matches the browser.
   */
  private readonly onServer: (() => DisplayLocale | undefined) | undefined;

  constructor(initial?: DisplayLocale, onServer?: () => DisplayLocale | undefined) {
    this.onServer = onServer;
    const boot = initial ?? readBoot();
    this.open = boot === undefined;
    this.current = boot ?? DEFAULT_LOCALE;
  }

  /** Whether the first-visit guess may still apply (nothing saved, nothing chosen). */
  get bootedWithoutChoice(): boolean {
    return this.open && readLocaleSource() !== 'chosen';
  }

  /**
   * R12 R2: apply the first-visit guess (`locale-hint.ts`) — saved with source `auto`. Refused
   * (`false`) once anything was chosen: a picker, the saved display preference or a `?lang=` link
   * always wins over a guess.
   */
  applyHint(locale: DisplayLocale): boolean {
    if (!this.bootedWithoutChoice || !isDisplayLocale(locale)) return false;
    this.open = false;
    writeLocaleSource('auto');
    if (locale === this.current) {
      persist(locale);
      return true;
    }
    this.publish(locale);
    return true;
  }

  /** The active locale right now. */
  get(): DisplayLocale {
    return this.onServer?.() ?? this.current;
  }

  /**
   * Publish a new active locale. Off-allowlist values are ignored rather than stored — the same
   * closed-allowlist discipline the server applies, so a stray string can never reach `dir` or a
   * formatter. A no-op change does not wake subscribers.
   */
  set(locale: DisplayLocale): void {
    if (!isDisplayLocale(locale)) return;
    // Any explicit set is a choice (R12 R2): the first-visit guess never overrides it.
    this.open = false;
    writeLocaleSource('chosen');
    if (locale === this.current) return;
    this.publish(locale);
  }

  private publish(locale: DisplayLocale): void {
    this.current = locale;
    persist(locale);
    for (const listener of [...this.listeners]) {
      try {
        listener(locale);
      } catch (error) {
        // One subscriber's failure must not stop the next from re-rendering.
        console.error('[locale-store] listener failed', error);
      }
    }
  }

  /** Register for locale changes. Returns the unsubscribe, for `useEffect`/`useSyncExternalStore`. */
  subscribe(listener: LocaleListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function readPersisted(): string | null {
  if (typeof globalThis.localStorage === 'undefined') return null;
  try {
    return globalThis.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readCookieHeader(): string | null {
  if (typeof globalThis.document === 'undefined') return null;
  try {
    return globalThis.document.cookie;
  } catch {
    return null;
  }
}

/**
 * The boot locale: an Arabic public page's path or `?lang=` (persisted when it wins), else the
 * cookie, else the cached locale.
 */
function readBoot(): DisplayLocale | undefined {
  const search = typeof globalThis.location === 'undefined' ? '' : globalThis.location.search;
  const pathname = typeof globalThis.location === 'undefined' ? '' : globalThis.location.pathname;
  const boot = resolveBootLocale(search, readPersisted(), readCookieHeader(), pathname);
  if (!boot) return undefined;
  if (boot.fromQuery) persist(boot.locale);
  else if (boot.saveCookie) writeLocaleCookie(boot.locale);
  return boot.locale;
}

function persist(locale: DisplayLocale): void {
  writeLocaleCookie(locale);
  if (typeof globalThis.localStorage === 'undefined') return;
  try {
    globalThis.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // A browser that refuses storage still gets the live in-memory switch; only the
    // flash-free reload is lost, which is a convenience, not the contract.
  }
}

/**
 * The application's active-locale store. Module-level for the same reason the auth boundary is:
 * the providers, the formatters and the screens must all reach the same instance. Tests build
 * their own.
 */
export const activeLocale = new LocaleStore(undefined, () => requestDisplay()?.locale);
