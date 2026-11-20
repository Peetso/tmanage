import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Inject, Module, Res } from '@nestjs/common';
import type { DynamicModule, OnApplicationBootstrap, Provider } from '@nestjs/common';
import { APP_GUARD, ModuleRef } from '@nestjs/core';
import { Public } from '../http/decorators.js';
import { MALWARE_SCANNER, TENANT_DATABASE } from '../http/tokens.js';
import type { MalwareScanner } from '../scan/malware-scanner.js';
import type { TenantDatabase } from '../database/tenant-context.js';
import {
  declaredTableNames,
  readMigrationLedger,
  schemaDriftReads,
} from './deep-health.repository.js';
import {
  SCHEMA_DRIFT_MONITOR,
  SchemaDriftGuard,
  SchemaDriftMonitor,
  readShippedMigrations,
} from './schema-drift.js';
import type { SchemaDriftMode, SchemaDriftState } from './schema-drift.js';
import { readBackupHealth } from './backup-health.repository.js';
import { readGrowthHealth } from './growth-health.repository.js';
import type { GrowthCheckState } from './growth-health.js';
import type { BackupCheckState } from './backup-health.js';
import { readLeaderHealth } from './leader-health.repository.js';
import type { LeaderCheck } from './leader-health.js';
import { ALERT_NOTIFIER } from './alerts.js';
import type { AlertNotifier } from './alerts.js';
import { OriginTlsMonitor } from './origin-tls.js';
import type { OriginTlsCheck } from './origin-tls.js';

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
 * - **scanner** — with `MALWARE_SCAN_DRIVER=clamav` and a host, the engine answered a `PING`
 *   (over TLS when `CLAMAV_TLS=1`) within the last {@link SCANNER_PROBE_CACHE_MS}: `ok`, else
 *   `unreachable`; `not_configured` otherwise. Reported only: an unreachable scanner parks
 *   files at `scanning`, it does not stop the app serving;
 * - **schema** — 56-27's schema-drift reading (`schema-drift.ts`): ledger checksums equal the
 *   shipped files and every declared table exists; `not_configured` when it cannot be read;
 * - **backups** — 51-09's reading of `platform_backup_runs` (`backup-health.ts`): `ok` / `stale` /
 *   `failed` / `not_configured`. Reported only — a late or failed backup is an alert, never a 503.
 * - **origin_tls** — 56-30's reading of the origin's own certificate (`origin-tls.ts`): `ok` while
 *   it has more than 14 days left, `fail` at 14 or fewer or when unreadable, `not_configured`
 *   without `ORIGIN_TLS_PROBE_ADDRESS`. Reported only (plus a daily operator alert), never a 503:
 *   the API answering here is itself proof the origin serves, and a 503 would not renew anything.
 * - **growth** — GROWTH-FIX: the platform growth figures' age (`growth-health.ts`): `ok` inside
 *   26 h, `stale` past it or never computed, `not_configured` when unreadable. Reported only.
 * - **realtime** — `ok` when the in-process socket is attached (`realtimeSocketUrl` set), else
 *   `not_configured`. Reported only.
 * - **leader** — DC-3 / RT-3: `held` with the opaque `instance` tag of the copy holding the leader
 *   lease (it runs the relay, sweeps and jobs), `vacant`, or `not_configured` (`leader-health.ts`).
 *   Info only.
 *
 * `fail` on database, migrations, worker or schema makes the answer 503 — the status code is what a
 * monitor matches on. `not_configured` is reported but is not a failure: a shared host that
 * keeps no heartbeat and runs no clamd is a supported shape, not an outage.
 *
 * Public by design (an uptime monitor has no session), so the body says only ok / fail per check:
 * no versions, counts, paths or error text. The result is cached for a few seconds so polling
 * this route cannot be turned into database load.
 */

export type CheckState = 'ok' | 'fail' | 'not_configured';
/** SCANNER-TLS. `unreachable`: configured, but the engine did not answer the probe. */
export type ScannerCheckState = 'ok' | 'unreachable' | 'not_configured';

export interface DeepHealthReport {
  readonly status: 'ok' | 'fail';
  readonly checks: {
    readonly database: CheckState;
    readonly migrations: CheckState;
    readonly worker: CheckState;
    readonly scanner: ScannerCheckState;
    readonly schema: CheckState;
    readonly backups: BackupCheckState;
    readonly origin_tls: OriginTlsCheck;
    readonly growth: GrowthCheckState;
    readonly realtime: 'ok' | 'not_configured';
    readonly leader: LeaderCheck;
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
  /**
   * 56-27. `enforce` refuses service (503) on schema drift; `report` only logs and reports.
   * `undefined` = `enforce` in production, `report` elsewhere.
   */
  readonly schemaDriftMode?: SchemaDriftMode | undefined;
  /** 56-30. `ORIGIN_TLS_PROBE_ADDRESS` (`<origin ip>:443`); unset = `origin_tls: not_configured`. */
  readonly originTlsAddress?: string | undefined;
  /** 56-30. SNI for that handshake; the host of `WEB_PUBLIC_URL`. */
  readonly originTlsServername?: string | undefined;
  /** 51-06. The API's `realtimeSocketUrl`: set only when the in-process socket is attached. */
  readonly realtimeSocketUrl?: string | null | undefined;
}

/** The readings the verdict is computed from — injected so the unit suite needs no database. */
export interface DeepHealthProbes {
  /** Every ledger row, or throws when the database cannot be read. */
  readLedger(): Promise<readonly { version: number; status: string }[]>;
  /** The versions shipped with this build, or `null` when the files cannot be found. */
  shippedVersions(): Promise<readonly number[] | null>;
  /** The last completed relay batch, or `null` when absent or unreadable. */
  readHeartbeat(path: string): Promise<Date | null>;
  /** SCANNER-TLS. The engine's `PING`; throws when it cannot be reached. Absent = not probed. */
  probeScanner?(): Promise<void>;
}

/**
 * SCANNER-TLS. How long one scanner reading stands. The route is public; without this bound a
 * poller could turn it into a TLS handshake to clamd every few seconds.
 */
export const SCANNER_PROBE_CACHE_MS = 60_000;

export const DEEP_HEALTH_CACHE_MS = 5_000;

/** Pure verdict over the probes. Never throws: a probe that throws is that check's `fail`. */
export async function evaluateDeepHealth(
  config: DeepHealthConfig,
  probes: DeepHealthProbes,
  now: Date,
  schema: SchemaDriftState = 'not_configured',
  backups: BackupCheckState = 'not_configured',
  originTls: OriginTlsCheck = { state: 'not_configured' },
  growth: GrowthCheckState = 'not_configured',
  leader: LeaderCheck = { state: 'not_configured' },
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

  let scanner: ScannerCheckState = 'not_configured';
  if (config.scannerDriver === 'clamav' && (config.scannerHost ?? '') !== '') {
    scanner =
      probes.probeScanner === undefined
        ? 'ok'
        : await probes.probeScanner().then(
            () => 'ok' as const,
            () => 'unreachable' as const,
          );
  }

  const realtime = config.realtimeSocketUrl ? 'ok' : 'not_configured';

  // By design only these four decide the 503; origin_tls, backups, growth, scanner, realtime and
  // leader report.
  const failed = [database, migrations, worker, schema].includes('fail');
  return {
    status: failed ? 'fail' : 'ok',
    checks: {
      database,
      migrations,
      worker,
      scanner,
      schema,
      backups,
      origin_tls: originTls,
      growth,
      realtime,
      leader,
    },
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
  /** 56-30. Owns the 1 h handshake cache and the once-per-UTC-day alert (`lastAlertDay`). */
  private readonly originTls: OriginTlsMonitor;

  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(DEEP_HEALTH_CONFIG) private readonly config: DeepHealthConfig,
    @Inject(SCHEMA_DRIFT_MONITOR) private readonly schemaDrift: SchemaDriftMonitor,
    @Inject(ModuleRef) moduleRef: ModuleRef,
  ) {
    // The notifier is a root-module provider; looked up non-strictly so this module needs no
    // new import, and absent (a bare test module) simply means no alert.
    const alerts = (): AlertNotifier | null => {
      try {
        return moduleRef.get<AlertNotifier | null>(ALERT_NOTIFIER, { strict: false });
      } catch {
        return null;
      }
    };
    this.originTls = new OriginTlsMonitor(
      { address: config.originTlsAddress, servername: config.originTlsServername },
      alerts,
    );
    const dir = findMigrationsDir(config.migrationsDir);
    // SCANNER-TLS. The scanner is `ScannerModule`'s global provider; looked up non-strictly
    // for the notifier's reason. One reading stands for SCANNER_PROBE_CACHE_MS.
    let scannerReading: { at: number; result: Promise<void> } | null = null;
    const probeScanner = (): Promise<void> => {
      const now = Date.now();
      if (scannerReading === null || now - scannerReading.at > SCANNER_PROBE_CACHE_MS) {
        let scanner: MalwareScanner | null = null;
        try {
          scanner = moduleRef.get<MalwareScanner>(MALWARE_SCANNER, { strict: false });
        } catch {
          scanner = null;
        }
        const result = scanner === null ? Promise.reject(new Error('no scanner')) : scanner.probe();
        result.catch(() => undefined);
        scannerReading = { at: now, result };
      }
      return scannerReading.result;
    };
    this.probes = {
      readLedger: () => readMigrationLedger(database),
      shippedVersions: async () =>
        dir === undefined ? null : versionsFromFilenames(await readdir(dir)),
      readHeartbeat: readHeartbeatFile,
      probeScanner,
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
      const schema = await this.schemaDrift.fresh();
      const backups = await readBackupHealth(this.database, new Date(now));
      const originTls = await this.originTls.check(new Date(now));
      const growth = await readGrowthHealth(this.database, new Date(now));
      const leader = await readLeaderHealth(this.database, new Date(now));
      this.cached = {
        at: now,
        report: await evaluateDeepHealth(
          this.config,
          this.probes,
          new Date(now),
          schema.state,
          backups,
          originTls,
          growth,
          leader,
        ),
      };
    }
    reply.header('cache-control', 'no-store');
    reply.status(this.cached.report.status === 'ok' ? 200 : 503);
    return this.cached.report;
  }
}

/** 56-27. `undefined` = `enforce` in production, `report` elsewhere (tests, development). */
export function schemaDriftModeOf(config: DeepHealthConfig): SchemaDriftMode {
  return (
    config.schemaDriftMode ?? (process.env['NODE_ENV'] === 'production' ? 'enforce' : 'report')
  );
}

@Module({})
export class DeepHealthModule implements OnApplicationBootstrap {
  constructor(@Inject(SCHEMA_DRIFT_MONITOR) private readonly schemaDrift: SchemaDriftMonitor) {}

  /** 56-27. The boot reading. Never blocks boot: it logs, and the guard acts on the verdict. */
  onApplicationBootstrap(): void {
    void this.schemaDrift.check();
  }

  static register(config: DeepHealthConfig): DynamicModule {
    const provider: Provider = { provide: DEEP_HEALTH_CONFIG, useValue: config };
    const monitor: Provider = {
      provide: SCHEMA_DRIFT_MONITOR,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => {
        const dir = findMigrationsDir(config.migrationsDir);
        return new SchemaDriftMonitor(
          declaredTableNames(),
          {
            ...schemaDriftReads(database),
            shippedMigrations: async () => (dir === undefined ? null : readShippedMigrations(dir)),
          },
          schemaDriftModeOf(config),
        );
      },
    };
    const guard: Provider = {
      provide: APP_GUARD,
      inject: [SCHEMA_DRIFT_MONITOR],
      useFactory: (m: SchemaDriftMonitor) => new SchemaDriftGuard(m),
    };
    return {
      module: DeepHealthModule,
      controllers: [DeepHealthController],
      providers: [provider, monitor, guard],
    };
  }
}
