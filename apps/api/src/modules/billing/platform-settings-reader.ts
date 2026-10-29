/**
 * platform-admin v2 · PA-07 — a 30-second cache over `platform_settings` (SPEC §7 item 10).
 *
 * Billing mode, the retention windows and the other platform switches live in one global table
 * the Platform admin writes (PA-10). Code that decides on every request — `billingMode()` above
 * all — must not read the database each time, and some of it is synchronous. So:
 *
 * - {@link PlatformSettingsReader.get} answers from the cache while it is fresh (30 s) and reads
 *   the row otherwise; a read that fails answers the last value it had (or `null`), never throws.
 * - {@link PlatformSettingsReader.peek} is the synchronous half: the cached value, or `undefined`
 *   when nothing has been read yet. A stale entry is still returned and a refresh starts in the
 *   background, so a synchronous caller lags a change by at most one refresh.
 *
 * One reader is installed per process ({@link installPlatformSettingsReader}) by the module that
 * owns a database handle (the loader's statement lives in its repository); until then {@link platformSettingsReader} is `null` and callers fall
 * back to their environment default. Tests build their own reader with a fake loader and clock.
 */

export const PLATFORM_SETTINGS_CACHE_MS = 30_000;

export type PlatformSettingLoader = (key: string) => Promise<string | null>;

interface Entry {
  readonly value: string | null;
  readonly readAt: number;
}

export class PlatformSettingsReader {
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(
    private readonly load: PlatformSettingLoader,
    private readonly ttlMs: number = PLATFORM_SETTINGS_CACHE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The setting's stored value (`null` when no row), at most {@link ttlMs} old. */
  async get(key: string): Promise<string | null> {
    const entry = this.cache.get(key);
    if (entry && this.now() - entry.readAt < this.ttlMs) return entry.value;
    return this.refresh(key);
  }

  /**
   * The cached value without waiting: `undefined` when the key was never read. A stale value is
   * returned as it is and refreshed in the background.
   */
  peek(key: string): string | null | undefined {
    const entry = this.cache.get(key);
    if (!entry || this.now() - entry.readAt >= this.ttlMs) void this.refresh(key);
    return entry?.value;
  }

  /** Forget a key so the next read goes to the database (after the Platform admin writes it). */
  invalidate(key?: string): void {
    if (key === undefined) this.cache.clear();
    else this.cache.delete(key);
  }

  private refresh(key: string): Promise<string | null> {
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const work = this.load(key)
      .then((value) => {
        this.cache.set(key, { value, readAt: this.now() });
        return value;
      })
      .catch(() => this.cache.get(key)?.value ?? null)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }
}

let installed: PlatformSettingsReader | null = null;

/** Install the process's reader (idempotent: the first install wins unless `replace`). */
export function installPlatformSettingsReader(
  reader: PlatformSettingsReader,
  replace = false,
): PlatformSettingsReader {
  if (installed === null || replace) installed = reader;
  return installed;
}

/** The process's reader, or `null` before a module installed one. */
export function platformSettingsReader(): PlatformSettingsReader | null {
  return installed;
}

/** Test seam: forget the installed reader. */
export function resetPlatformSettingsReader(): void {
  installed = null;
}
