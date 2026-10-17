import { DISPLAY_LOCALES, type DisplayLocale } from '../api/display-preferences';

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
 * The initial value is read once from `localStorage` so a reload paints the right direction
 * before the preference query resolves (no left-to-right flash for an Arabic member); it falls
 * back to the shipped default. `localStorage` is a per-browser convenience here, never the
 * source of truth — the server preference is — so a read that throws (private mode, blocked
 * storage) simply yields the default. Nothing is stored that identifies the member.
 */

export const DEFAULT_LOCALE: DisplayLocale = 'en-US';

/** The key the active locale is cached under, for a flash-free reload. */
export const LOCALE_STORAGE_KEY = 'tmanage:locale';

const ALLOWED: ReadonlySet<string> = new Set(DISPLAY_LOCALES);

function isDisplayLocale(value: unknown): value is DisplayLocale {
  return typeof value === 'string' && ALLOWED.has(value);
}

export type LocaleListener = (locale: DisplayLocale) => void;

export class LocaleStore {
  private current: DisplayLocale;
  private readonly listeners = new Set<LocaleListener>();

  constructor(initial?: DisplayLocale) {
    this.current = initial ?? readPersisted() ?? DEFAULT_LOCALE;
  }

  /** The active locale right now. */
  get(): DisplayLocale {
    return this.current;
  }

  /**
   * Publish a new active locale. Off-allowlist values are ignored rather than stored — the same
   * closed-allowlist discipline the server applies, so a stray string can never reach `dir` or a
   * formatter. A no-op change does not wake subscribers.
   */
  set(locale: DisplayLocale): void {
    if (!isDisplayLocale(locale) || locale === this.current) return;
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

function readPersisted(): DisplayLocale | undefined {
  if (typeof globalThis.localStorage === 'undefined') return undefined;
  try {
    const raw = globalThis.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isDisplayLocale(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function persist(locale: DisplayLocale): void {
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
export const activeLocale = new LocaleStore();
