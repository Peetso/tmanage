/**
 * R12 (R1). The Tor exit addresses, kept in memory and refreshed hourly from
 * `GEOIP_TOR_EXIT_LIST_URL` (documented value https://check.torproject.org/torbulkexitlist).
 * Off by default: with no URL, nothing is fetched and no address is Tor.
 */
export const TOR_REFRESH_MS = 60 * 60 * 1000;

type Fetch = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

export class TorExitList {
  private exits: ReadonlySet<string> = new Set();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly url: string | undefined,
    private readonly fetcher: Fetch = (target) => fetch(target),
    private readonly log: (message: string) => void = console.warn,
  ) {}

  has(ip: string): boolean {
    return this.exits.has(ip.trim());
  }

  /** Start the hourly refresh. A no-op when no URL is configured. */
  start(): void {
    if (!this.url || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), TOR_REFRESH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One fetch; a failure keeps the previous set. */
  async refresh(): Promise<void> {
    if (!this.url) return;
    try {
      const response = await this.fetcher(this.url);
      if (!response.ok) throw new Error('unexpected status');
      const lines = (await response.text()).split(/\r?\n/);
      this.exits = new Set(
        lines.map((line) => line.trim()).filter((line) => /^[0-9a-f.:]+$/i.test(line)),
      );
    } catch (error) {
      this.log(
        `[geo] Tor exit list refresh failed; keeping ${String(this.exits.size)} addresses (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }
}
