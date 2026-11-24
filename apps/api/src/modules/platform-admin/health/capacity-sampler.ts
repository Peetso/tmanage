import { lstat, opendir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { IntervalHistogram } from 'node:perf_hooks';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { AlertNotifier } from '../../../common/observability/alerts.js';
import { DailyRedAlertGate, alertKind, parseHostProfile, redGauges } from './capacity-budget.js';
import type { CapacityReading, CapacitySource } from './capacity-budget.js';
import { CAPACITY_RETENTION_DAYS } from './capacity.repository.js';
import type { CapacityStore } from './capacity.repository.js';

/**
 * 56-32 — the host capacity sampler (spec 56 §12.2).
 *
 * Every 30 s it reads this process's memory (`process.memoryUsage()`), the p95 event-loop delay
 * (`perf_hooks.monitorEventLoopDelay`) and the open TCP sockets (`process.getActiveResourcesInfo()`)
 * and keeps them in memory. Every 5 minutes it persists one `sample` row holding the window's
 * peaks. Once a day, on the first tick after 03:30 UTC, it writes a `nightly` row that also counts
 * the inodes under the app root (a streaming `opendir` walk, capped at 60 s, skipping
 * `TMANAGE_INODE_EXCLUDE`), the disk in use (the bytes of the files under the app root, summed by a
 * second capped walk — not `statfs`, which on shared hosting reports the whole server's disk, every
 * customer's files, e.g. 5.7 TiB against a 50 GB plan), the schema size and the
 * connection count — then purges rows older than 90 days. A red gauge alerts `capacity:red:<gauge>`
 * once per UTC day.
 *
 * Nothing it does may throw out of the interval: a failed read, insert or alert is reported on
 * stderr and the next tick runs as usual. The timer is `unref`'d so it never holds the process up.
 */

export const SAMPLE_EVERY_MS = 30_000;
export const PERSIST_EVERY_MS = 5 * 60_000;
export const INODE_WALK_CAP_MS = 60_000;
const NIGHTLY_UTC_HOUR = 3;
const NIGHTLY_UTC_MINUTE = 30;
const MIB = 1024 * 1024;
const DAY_MS = 24 * 3600 * 1000;

export interface LiveSnapshot {
  readonly rssMb: number;
  readonly heapMb: number;
  readonly loopLagMs: number;
  readonly sockets: number;
}

export interface InodeCount {
  readonly count: number;
  /** True when the walk hit its time cap; the count is then an undercount and is not stored. */
  readonly truncated: boolean;
}

export interface HostProbes {
  live(): LiveSnapshot;
  countInodes(root: string, exclude: readonly string[]): Promise<InodeCount>;
  diskUsedMb(root: string, exclude?: readonly string[]): Promise<number | null>;
}

export interface CapacitySamplerOptions {
  readonly store: CapacityStore;
  readonly alerts: Pick<AlertNotifier, 'notify'> | null;
  readonly probes?: HostProbes;
  readonly appRoot?: string;
  readonly inodeExclude?: readonly string[];
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  /** False = never start the timer (tests drive `tick()` themselves). */
  readonly autoStart?: boolean;
}

/** Count directory entries under `root`, iteratively, with a deadline. Symlinks are not followed. */
export async function countInodes(
  root: string,
  exclude: readonly string[],
  capMs: number = INODE_WALK_CAP_MS,
  clock: () => number = Date.now,
): Promise<InodeCount> {
  const deadline = clock() + capMs;
  const skipped = new Set(exclude.map((p) => resolve(p)));
  const stack = [resolve(root)];
  let count = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    if (skipped.has(dir)) continue;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      continue;
    }
    count += 1;
    for await (const entry of handle) {
      if (clock() > deadline) return { count, truncated: true };
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (!skipped.has(full)) {
        count += 1;
      }
    }
  }
  return { count, truncated: false };
}

export interface ByteSum {
  readonly bytes: number;
  /** True when the walk hit its time cap; the sum is then an undercount and is not stored. */
  readonly truncated: boolean;
}

/**
 * Sum the sizes of the files under `root` (lstat, so a symlink counts as itself and is not
 * followed), iteratively, with a deadline. This is the account's own disk use; the plan's disk
 * ceiling is per account, while `statfs` would read the shared server's whole volume.
 */
export async function sumFileBytes(
  root: string,
  exclude: readonly string[],
  capMs: number = INODE_WALK_CAP_MS,
  clock: () => number = Date.now,
): Promise<ByteSum> {
  const deadline = clock() + capMs;
  const skipped = new Set(exclude.map((p) => resolve(p)));
  const stack = [resolve(root)];
  let bytes = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    if (skipped.has(dir)) continue;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      if (clock() > deadline) return { bytes, truncated: true };
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (!skipped.has(full)) {
        try {
          bytes += (await lstat(full)).size;
        } catch {
          // Gone between the listing and the stat: nothing to count.
        }
      }
    }
  }
  return { bytes, truncated: false };
}

function openSockets(): number {
  const info = (
    process as unknown as { getActiveResourcesInfo?: () => string[] }
  ).getActiveResourcesInfo?.();
  return info === undefined ? 0 : info.filter((kind) => kind === 'TCPSocketWrap').length;
}

/** The real probes. The loop-delay histogram is reset after each read, so each read is a window. */
export function nodeProbes(histogram: IntervalHistogram): HostProbes {
  return {
    live: () => {
      const memory = process.memoryUsage();
      const p95 = histogram.percentile(95);
      histogram.reset();
      return {
        rssMb: Math.round(memory.rss / MIB),
        heapMb: Math.round(memory.heapUsed / MIB),
        loopLagMs: Number.isFinite(p95) ? Math.round(p95 / 1e6) : 0,
        sockets: openSockets(),
      };
    },
    countInodes: (root, exclude) => countInodes(root, exclude),
    diskUsedMb: async (root, exclude = []) => {
      try {
        const sum = await sumFileBytes(root, exclude);
        return sum.truncated ? null : Math.round(sum.bytes / MIB);
      } catch {
        return null;
      }
    },
  };
}

/** The next 03:30 UTC strictly after `from`. */
export function nextNightlyAt(from: Date): Date {
  const next = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      NIGHTLY_UTC_HOUR,
      NIGHTLY_UTC_MINUTE,
    ),
  );
  if (next.getTime() <= from.getTime()) next.setTime(next.getTime() + DAY_MS);
  return next;
}

/** `TMANAGE_INODE_EXCLUDE` → absolute paths (relative entries resolve against the app root). */
export function parseInodeExclude(raw: string | undefined, appRoot: string): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => (isAbsolute(p) ? resolve(p) : resolve(appRoot, p)));
}

export class CapacitySampler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly window: LiveSnapshot[] = [];
  private readonly gate = new DailyRedAlertGate();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly appRoot: string;
  private readonly inodeExclude: readonly string[];
  private histogram: IntervalHistogram | null = null;
  private probes: HostProbes | null;
  private timer: NodeJS.Timeout | null = null;
  private lastPersistAt: number;
  private nightlyDueAt: Date;
  private running = false;

  constructor(private readonly options: CapacitySamplerOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.appRoot = resolve(options.appRoot ?? process.cwd());
    this.inodeExclude = options.inodeExclude ?? [];
    this.probes = options.probes ?? null;
    const started = this.now();
    this.lastPersistAt = started.getTime();
    this.nightlyDueAt = nextNightlyAt(started);
  }

  onApplicationBootstrap(): void {
    if (this.options.autoStart === false) return;
    if (this.probes === null) {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
      this.probes = nodeProbes(this.histogram);
    }
    this.timer = setInterval(() => void this.tick(), SAMPLE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.histogram?.disable();
  }

  /** The in-memory snapshots since the last persisted sample. */
  snapshots(): readonly LiveSnapshot[] {
    return this.window;
  }

  /** One 30 s tick. Never throws. Ticks never overlap (a slow nightly walk skips ticks). */
  async tick(): Promise<void> {
    if (this.running || this.probes === null) return;
    this.running = true;
    try {
      this.window.push(this.probes.live());
      const now = this.now();
      if (now.getTime() >= this.nightlyDueAt.getTime()) {
        this.nightlyDueAt = nextNightlyAt(now);
        await this.persistNightly(now);
      } else if (now.getTime() - this.lastPersistAt >= PERSIST_EVERY_MS) {
        await this.persistSample(now);
      }
    } catch (error) {
      this.log(`capacity sampler: tick failed (${(error as Error).name})`);
    } finally {
      this.running = false;
    }
  }

  private peak(): LiveSnapshot {
    const seen = this.window.length > 0 ? this.window : [this.probes?.live() as LiveSnapshot];
    return {
      rssMb: Math.max(...seen.map((s) => s.rssMb)),
      heapMb: Math.max(...seen.map((s) => s.heapMb)),
      loopLagMs: Math.max(...seen.map((s) => s.loopLagMs)),
      sockets: Math.max(...seen.map((s) => s.sockets)),
    };
  }

  private baseReading(source: CapacitySource, at: Date): CapacityReading {
    const peak = this.peak();
    this.window.length = 0;
    this.lastPersistAt = at.getTime();
    return {
      takenAt: at,
      source,
      rssMb: peak.rssMb,
      heapMb: peak.heapMb,
      loopLagMs: peak.loopLagMs,
      sockets: peak.sockets,
      inodes: null,
      diskMb: null,
      dbMb: null,
      dbConnections: null,
    };
  }

  async persistSample(at: Date = this.now()): Promise<CapacityReading> {
    const reading = this.baseReading('sample', at);
    await this.options.store.insert(reading);
    await this.alertIfRed(reading);
    return reading;
  }

  async persistNightly(at: Date = this.now()): Promise<CapacityReading> {
    const probes = this.probes as HostProbes;
    const base = this.baseReading('nightly', at);
    const [inodes, diskMb, figures] = await Promise.all([
      probes.countInodes(this.appRoot, this.inodeExclude).catch(() => null),
      probes.diskUsedMb(this.appRoot, this.inodeExclude).catch(() => null),
      this.options.store.readDatabaseFigures().catch(() => ({ dbMb: null, dbConnections: null })),
    ]);
    const reading: CapacityReading = {
      ...base,
      inodes: inodes === null || inodes.truncated ? null : inodes.count,
      diskMb,
      dbMb: figures.dbMb,
      dbConnections: figures.dbConnections,
    };
    await this.options.store.insert(reading);
    await this.options.store.purgeOlderThan(
      new Date(at.getTime() - CAPACITY_RETENTION_DAYS * DAY_MS),
    );
    await this.alertIfRed(reading);
    return reading;
  }

  private async alertIfRed(reading: CapacityReading): Promise<void> {
    if (this.options.alerts === null) return;
    try {
      const profile = parseHostProfile(await this.options.store.readProfileJson());
      for (const key of redGauges(profile, reading)) {
        if (this.gate.shouldAlert(key, reading.takenAt)) {
          await this.options.alerts.notify(alertKind(key), { detail: `source=${reading.source}` });
        }
      }
    } catch (error) {
      this.log(`capacity sampler: alert check failed (${(error as Error).name})`);
    }
  }
}
