import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Inject, Module, Res } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { Public } from '../http/decorators.js';
import { TENANT_DATABASE } from '../http/tokens.js';
import type { TenantDatabase } from '../database/tenant-context.js';
import { readMigrationLedger } from './deep-health.repository.js';

/**
 * `GET /healthz/deep` (C10) — the readiness check a free external uptime monitor polls.
 *
 * `/healthz` (apps/server) says the process is up. This says whether it can do its job:
 *
 * - **database** — a read reaches the server;
 * - **migrations** — no migration is `running` or `failed`, and every file shipped with this
 *   build is recorded as applied (a deploy whose schema did not land answers 503 here);
 * - **worker** — the relay's heartbeat file (`OUTBOX_HEARTBEAT_FILE`) is fresher than
 *   `OUTBOX_HEARTBEAT_MAX_AGE_SECONDS`; `not_configured` when no heartbeat is kept;
 * - **scanner** — a malware scanner (`MALWARE_SCAN_DRIVER=clamav` with a host) is configured;
 *   `not_configured` otherwise.
 *
 * `fail` on database, migrations or worker makes the answer 503 — the status code is what a
 * monitor matches on. `not_configured` is reported but is not a failure: a shared host that
 * keeps no heartbeat and runs no clamd is a supported shape, not an outage.
 *
 * Public by design (an uptime monitor has no session), so the body says only ok / fail per check:
 * no versions, counts, paths or error text. The result is cached for a few seconds so polling
 * this route cannot be turned into database load.
 */

export type CheckState = 'ok' | 'fail' | 'not_configured';

export interface DeepHealthReport {
  readonly status: 'ok' | 'fail';
  readonly checks: {
    readonly database: CheckState;
    readonly migrations: CheckState;
    readonly worker: CheckState;
    readonly scanner: CheckState;
  };
  readonly checkedAt: string;
}

export interface DeepHealthConfig {
  readonly heartbeatFile?: string | undefined;
  readonly heartbeatMaxAgeSeconds: number;
  readonly scannerDriver?: string | undefined;
  readonly scannerHost?: string | undefined;
  /** Where this build's migration files are; `undefined` = find them (see {@link findMigrationsDir}). */
  readonly migrationsDir?: string | undefined;
}

/** The readings the verdict is computed from — injected so the unit suite needs no database. */
export interface DeepHealthProbes {
  /** Every ledger row, or throws when the database cannot be read. */
  readLedger(): Promise<readonly { version: number; status: string }[]>;
  /** The versions shipped with this build, or `null` when the files cannot be found. */
  shippedVersions(): Promise<readonly number[] | null>;
  /** The last completed relay batch, or `null` when absent or unreadable. */
  readHeartbeat(path: string): Promise<Date | null>;
}

export const DEEP_HEALTH_CACHE_MS = 5_000;

/** Pure verdict over the probes. Never throws: a probe that throws is that check's `fail`. */
export async function evaluateDeepHealth(
  config: DeepHealthConfig,
  probes: DeepHealthProbes,
  now: Date,
): Promise<DeepHealthReport> {
  let database: CheckState = 'ok';
  let migrations: CheckState = 'ok';
  try {
    const ledger = await probes.readLedger();
    const applied = new Set(ledger.filter((r) => r.status === 'applied').map((r) => r.version));
    if (ledger.some((r) => r.status !== 'applied')) migrations = 'fail';
    const shipped = await probes.shippedVersions().catch(() => null);
    if (shipped !== null && shipped.some((v) => !applied.has(v))) migrations = 'fail';
  } catch {
    database = 'fail';
    migrations = 'fail';
  }

  let worker: CheckState = 'not_configured';
  if (config.heartbeatFile !== undefined && config.heartbeatFile !== '') {
    const at = await probes.readHeartbeat(config.heartbeatFile).catch(() => null);
    const ageSeconds = at === null ? Infinity : (now.getTime() - at.getTime()) / 1_000;
    worker = ageSeconds <= config.heartbeatMaxAgeSeconds ? 'ok' : 'fail';
  }

  const scanner: CheckState =
    config.scannerDriver === 'clamav' && (config.scannerHost ?? '') !== ''
      ? 'ok'
      : 'not_configured';

  const failed = [database, migrations, worker].includes('fail');
  return {
    status: failed ? 'fail' : 'ok',
    checks: { database, migrations, worker, scanner },
    checkedAt: now.toISOString(),
  };
}

/** `0001_name.sql` → 1. The migrator's own naming rule. */
export function versionsFromFilenames(names: readonly string[]): readonly number[] {
  const out: number[] = [];
  for (const name of names) {
    const match = /^(\d{4,})_[A-Za-z0-9_-]+\.sql$/u.exec(name);
    if (match?.[1] !== undefined) out.push(Number(match[1]));
  }
  return out;
}

/**
 * The migration directory of this build: `TMANAGE_MIGRATIONS_DIR` when set (the Hostinger
 * server sets the same variable it migrates from), else `apps/api/migrations` relative to this
 * file (src or dist), else `./migrations` under the working directory (the bundle's layout).
 */
export function findMigrationsDir(explicit: string | undefined): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    explicit,
    process.env['TMANAGE_MIGRATIONS_DIR'],
    resolve(here, '../../../migrations'),
    resolve(process.cwd(), 'migrations'),
  ];
  return candidates.find((c) => c !== undefined && c !== '' && existsSync(c));
}

async function readHeartbeatFile(path: string): Promise<Date | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    const value = (parsed as Record<string, unknown>)['lastPollAt'];
    if (typeof value !== 'string') return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

export const DEEP_HEALTH_CONFIG = Symbol.for('tmanage.DeepHealthConfig');

@Controller('healthz')
export class DeepHealthController {
  private cached: { at: number; report: DeepHealthReport } | null = null;
  private readonly probes: DeepHealthProbes;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Inject(DEEP_HEALTH_CONFIG) private readonly config: DeepHealthConfig,
  ) {
    const dir = findMigrationsDir(config.migrationsDir);
    this.probes = {
      readLedger: () => readMigrationLedger(database),
      shippedVersions: async () =>
        dir === undefined ? null : versionsFromFilenames(await readdir(dir)),
      readHeartbeat: readHeartbeatFile,
    };
  }

  @Get('deep')
  @Public()
  async deep(
    @Res({ passthrough: true })
    reply: {
      status(code: number): unknown;
      header(name: string, value: string): unknown;
    },
  ): Promise<DeepHealthReport> {
    const now = Date.now();
    if (this.cached === null || now - this.cached.at > DEEP_HEALTH_CACHE_MS) {
      this.cached = {
        at: now,
        report: await evaluateDeepHealth(this.config, this.probes, new Date(now)),
      };
    }
    reply.header('cache-control', 'no-store');
    reply.status(this.cached.report.status === 'ok' ? 200 : 503);
    return this.cached.report;
  }
}

@Module({})
export class DeepHealthModule {
  static register(config: DeepHealthConfig): DynamicModule {
    const provider: Provider = { provide: DEEP_HEALTH_CONFIG, useValue: config };
    return { module: DeepHealthModule, controllers: [DeepHealthController], providers: [provider] };
  }
}
