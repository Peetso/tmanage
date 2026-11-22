/**
 * SEC-ALERTS item 7, layer A — the daily refresh of the free anonymous-network lists that the
 * sign-in door (`apps/api/src/modules/identity/network-access/`) refuses. It runs beside the
 * ip-lookup sweep, under its own sweep lock (`network-block-lists`), hourly; each list is fetched
 * only when its last good fetch is older than its cadence, so a restart does not re-download.
 *
 * | list             | source                                                    | licence / terms                                   | cadence |
 * | ---------------- | --------------------------------------------------------- | ------------------------------------------------- | ------- |
 * | `x4b_vpn`        | github.com/X4BNet/lists_vpn `output/vpn/ipv4.txt`         | MIT per the README (no LICENSE file); part built  | 24 h    |
 * | `x4b_datacenter` | same repository, `output/datacenter/ipv4.txt`             | from IPLocate data, CC BY-SA 4.0                  | 24 h    |
 * | `tor_exit`       | check.torproject.org/torbulkexitlist                      | Tor Project public list                           | 24 h    |
 * | `ip2proxy_px1`   | ip2location.com/download (token, `IP2PROXY_LITE_TOKEN`)   | IP2Proxy LITE, free with attribution              | 7 days  |
 *
 * X4BNet publishes `ipv4.txt` and `ipv6.txt` for each list; both are fetched into one list.
 * IP2Proxy LITE PX1 holds open public proxies only (not commercial VPNs) and is about 3.1 million
 * rows (lite.ip2location.com, 2026-11-22), so it is refreshed weekly; without a token it is
 * skipped and the skip is logged once per process. The token is a secret: it is put in the URL
 * the fetcher calls and nowhere else; an error message never carries the URL.
 *
 * A refresh is versioned: the new ranges go in under a fresh version, `active_version` switches in
 * one update, then the old version's rows are deleted. A reader sees the old list or the new one,
 * never a half-written one. A failed fetch keeps the active version and records the error text.
 *
 * Ranges are merged before they are stored (sorted, overlapping and adjacent ranges joined), so
 * the API's lookup — the greatest `range_start` not above the address, then `range_end` — is
 * exact. The small lists are sorted in memory; PX1 is streamed in its published order (ascending
 * `ip_from`) and merged on the fly, because three million ranges do not belong in memory.
 *
 * This file holds no SQL; `common/database/network-block-lists-store.ts` does.
 */
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { ipV4NumericRange, parseIpRange } from '@tmanage/domain';
import type { IpRange } from '@tmanage/domain';
import { zipEntryLines } from './zip-entry-lines.js';

export const NETWORK_BLOCK_LISTS_TICK_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const RANGE_BATCH = 1000;
/** A list longer than this is refused as malformed rather than stored. */
export const MAX_RANGES_PER_LIST = 5_000_000;
export const FETCH_TIMEOUT_MS = 5 * 60 * 1000;

export type BlockListKey = 'x4b_vpn' | 'x4b_datacenter' | 'tor_exit' | 'ip2proxy_px1';

export interface BlockListSource {
  readonly key: BlockListKey;
  readonly cadenceMs: number;
  /** The URLs to fetch into the one list, or null when the list cannot run (no token). */
  urls(env: NetworkBlockListEnv): readonly string[] | null;
  /** `lines`: one address or CIDR per line; `px1-zip`: the IP2Proxy LITE CSV inside a ZIP. */
  readonly format: 'lines' | 'px1-zip';
}

export interface NetworkBlockListEnv {
  readonly IP2PROXY_LITE_TOKEN?: string | undefined;
}

const X4B = 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output';

export const BLOCK_LIST_SOURCES: readonly BlockListSource[] = [
  {
    key: 'x4b_vpn',
    cadenceMs: DAY_MS,
    format: 'lines',
    urls: () => [`${X4B}/vpn/ipv4.txt`, `${X4B}/vpn/ipv6.txt`],
  },
  {
    key: 'x4b_datacenter',
    cadenceMs: DAY_MS,
    format: 'lines',
    urls: () => [`${X4B}/datacenter/ipv4.txt`, `${X4B}/datacenter/ipv6.txt`],
  },
  {
    key: 'tor_exit',
    cadenceMs: DAY_MS,
    format: 'lines',
    urls: () => ['https://check.torproject.org/torbulkexitlist'],
  },
  {
    key: 'ip2proxy_px1',
    cadenceMs: 7 * DAY_MS,
    format: 'px1-zip',
    // The download code of the PX1 LITE IPv4 CSV (lite.ip2location.com download page).
    urls: (env) =>
      env.IP2PROXY_LITE_TOKEN
        ? [
            `https://www.ip2location.com/download?token=${encodeURIComponent(env.IP2PROXY_LITE_TOKEN)}&file=PX1LITECSV`,
          ]
        : null,
  },
];

export interface BlockListState {
  readonly listKey: string;
  readonly activeVersion: string | null;
  readonly fetchedAt: Date | null;
}

export interface NetworkBlockListStore {
  lists(): Promise<readonly BlockListState[]>;
  /** Insert one batch of ranges under `version`. */
  writeRanges(listKey: string, version: string, ranges: readonly IpRange[]): Promise<void>;
  /** Switch the list to `version`, then delete every other version's rows. */
  activate(listKey: string, version: string, rangeCount: number, now: Date): Promise<void>;
  /** Delete one version's rows (a refresh that failed half-way). */
  dropVersion(listKey: string, version: string): Promise<void>;
  recordFailure(listKey: string, message: string, now: Date): Promise<void>;
}

export interface FetchedBody {
  readonly ok: boolean;
  readonly status: number;
  readonly body: ReadableStream<Uint8Array> | null;
}
export type BlockListFetch = (url: string, signal: AbortSignal) => Promise<FetchedBody>;

export const defaultFetch: BlockListFetch = async (url, signal) => {
  const response = await fetch(url, { signal, headers: { 'user-agent': 'tmanage-blocklist/1' } });
  return { ok: response.ok, status: response.status, body: response.body };
};

/** Sort and merge ranges: overlapping or touching ranges become one. */
export function mergeRanges(ranges: Iterable<IpRange>): IpRange[] {
  const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: IpRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && touches(last.end, range.start)) {
      if (range.end > last.end) out[out.length - 1] = { start: last.start, end: range.end };
      continue;
    }
    out.push(range);
  }
  return out;
}

/** True when `start` is at or below `end + 1` (both 32-hex keys). */
function touches(end: string, start: string): boolean {
  return BigInt(`0x${start}`) <= BigInt(`0x${end}`) + 1n;
}

/** One PX1 CSV line (`"ip_from","ip_to","country_code","country_name"`) as a range. */
export function parsePx1Line(line: string): IpRange | null {
  const match = /^"(\d+)","(\d+)"/u.exec(line);
  return match ? ipV4NumericRange(match[1] ?? '', match[2] ?? '') : null;
}

/** Lines of a body stream, decoded as UTF-8. */
async function* bodyLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const input = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  yield* createInterface({ input, crlfDelay: Infinity });
}

/** A fresh, unguessable version id (16 hex), written before the rows it labels. */
export function newVersion(): string {
  return randomBytes(8).toString('hex');
}

/** The error text worth storing: the message, never a URL (the PX1 URL carries the token). */
export function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/https?:\/\/\S+/gu, '<url>').slice(0, 255);
}

export interface RefreshOutcome {
  readonly key: BlockListKey;
  readonly status: 'fresh' | 'skipped' | 'refreshed' | 'failed';
  readonly ranges?: number;
}

let px1SkipLogged = false;

/** One refresh pass over every list that is due. */
export async function refreshNetworkBlockLists(deps: {
  readonly store: NetworkBlockListStore;
  readonly env: NetworkBlockListEnv;
  readonly fetcher?: BlockListFetch;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
  readonly sources?: readonly BlockListSource[];
}): Promise<readonly RefreshOutcome[]> {
  const now = (deps.now ?? (() => new Date()))();
  const fetcher = deps.fetcher ?? defaultFetch;
  const log = deps.log ?? console.warn;
  const state = new Map((await deps.store.lists()).map((row) => [row.listKey, row]));
  const outcomes: RefreshOutcome[] = [];
  for (const source of deps.sources ?? BLOCK_LIST_SOURCES) {
    const urls = source.urls(deps.env);
    if (urls === null) {
      if (!px1SkipLogged) {
        px1SkipLogged = true;
        log(`[worker] network-block-lists: ${source.key} skipped (IP2PROXY_LITE_TOKEN is not set)`);
      }
      outcomes.push({ key: source.key, status: 'skipped' });
      continue;
    }
    const fetchedAt = state.get(source.key)?.fetchedAt ?? null;
    if (fetchedAt !== null && now.getTime() - fetchedAt.getTime() < source.cadenceMs) {
      outcomes.push({ key: source.key, status: 'fresh' });
      continue;
    }
    const version = newVersion();
    try {
      const count = await fetchAndStore(source, urls, version, deps.store, fetcher);
      await deps.store.activate(source.key, version, count, now);
      outcomes.push({ key: source.key, status: 'refreshed', ranges: count });
    } catch (error) {
      const message = safeError(error);
      await deps.store.dropVersion(source.key, version).catch(() => undefined);
      await deps.store.recordFailure(source.key, message, now);
      log(`[worker] network-block-lists: ${source.key} refresh failed (${message})`);
      outcomes.push({ key: source.key, status: 'failed' });
    }
  }
  return outcomes;
}

async function fetchAndStore(
  source: BlockListSource,
  urls: readonly string[],
  version: string,
  store: NetworkBlockListStore,
  fetcher: BlockListFetch,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  const open = async (url: string): Promise<ReadableStream<Uint8Array>> => {
    const response = await fetcher(url, controller.signal);
    if (!response.ok || response.body === null) {
      throw new Error(`unexpected status ${String(response.status)}`);
    }
    return response.body;
  };
  try {
    if (source.format === 'lines') {
      const ranges: IpRange[] = [];
      for (const url of urls) {
        for await (const line of bodyLines(await open(url))) {
          const range = parseIpRange(line);
          if (range !== null) ranges.push(range);
          if (ranges.length > MAX_RANGES_PER_LIST) throw new Error('list too long');
        }
      }
      const merged = mergeRanges(ranges);
      if (merged.length === 0) throw new Error('list is empty');
      for (let i = 0; i < merged.length; i += RANGE_BATCH) {
        await store.writeRanges(source.key, version, merged.slice(i, i + RANGE_BATCH));
      }
      return merged.length;
    }
    return await streamPx1(await open(urls[0] ?? ''), source.key, version, store);
  } finally {
    clearTimeout(timer);
  }
}

/** PX1: stream the CSV out of the ZIP, merge consecutive ranges, write in batches. */
async function streamPx1(
  body: ReadableStream<Uint8Array>,
  listKey: string,
  version: string,
  store: NetworkBlockListStore,
): Promise<number> {
  const input = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
  let batch: IpRange[] = [];
  let current: IpRange | null = null;
  let count = 0;
  const flush = async (): Promise<void> => {
    if (batch.length > 0) await store.writeRanges(listKey, version, batch);
    batch = [];
  };
  for await (const line of zipEntryLines(input, (name) => name.toUpperCase().endsWith('.CSV'))) {
    const range = parsePx1Line(line);
    if (range === null) continue;
    if (current !== null && range.start < current.start) {
      throw new Error('PX1 rows are not in ascending order');
    }
    if (current !== null && touches(current.end, range.start)) {
      if (range.end > current.end) current = { start: current.start, end: range.end };
      continue;
    }
    if (current !== null) {
      batch.push(current);
      count += 1;
      if (batch.length >= RANGE_BATCH) await flush();
    }
    current = range;
    if (count > MAX_RANGES_PER_LIST) throw new Error('list too long');
  }
  if (current !== null) {
    batch.push(current);
    count += 1;
  }
  await flush();
  if (count === 0) throw new Error('list is empty');
  return count;
}
