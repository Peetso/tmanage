import type { ResultSetHeader } from 'mysql2/promise';
import { uuidv7 } from '@tmanage/domain';
import type { QueryRows, TenantDatabase } from '../../../common/database/tenant-context.js';
import { CAPACITY_SOURCES } from './capacity-budget.js';
import type { CapacityReading, CapacitySource } from './capacity-budget.js';

/**
 * 56-32 — `host_capacity_readings` (0254) and the `host_profile_json` setting, on the identity
 * path: both tables are registered global in `tenant-guard.ts`. The API inserts and purges
 * readings (users.sql grants INSERT, DELETE); the profile is read-only here — it is written by
 * `scripts/ops/host-profile.mjs` through the migration credential.
 */
export const HOST_PROFILE_SETTING_KEY = 'host_profile_json';

/** 90-day retention. */
export const CAPACITY_RETENTION_DAYS = 90;

const COLUMNS =
  'taken_at, source, rss_mb, heap_mb, loop_lag_ms, sockets, inodes, disk_mb, db_mb, db_connections';

const INSERT_SQL = `insert into host_capacity_readings (id, ${COLUMNS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export interface DatabaseFigures {
  readonly dbMb: number | null;
  readonly dbConnections: number | null;
}

export interface CapacityStore {
  insert(reading: CapacityReading): Promise<void>;
  purgeOlderThan(cutoff: Date): Promise<number>;
  readDatabaseFigures(): Promise<DatabaseFigures>;
  readProfileJson(): Promise<string | null>;
  latest(source: CapacitySource): Promise<CapacityReading | null>;
  /** The newest `limit` nightly readings, newest first. */
  recentNightly(limit: number): Promise<CapacityReading[]>;
}

function nullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toReading(row: QueryRows[number]): CapacityReading {
  const source = String(row['source']);
  return {
    takenAt: new Date(row['taken_at'] as Date | string),
    source: (CAPACITY_SOURCES as readonly string[]).includes(source)
      ? (source as CapacitySource)
      : 'sample',
    rssMb: Number(row['rss_mb']),
    heapMb: Number(row['heap_mb']),
    loopLagMs: Number(row['loop_lag_ms']),
    sockets: nullableInt(row['sockets']),
    inodes: nullableInt(row['inodes']),
    diskMb: nullableInt(row['disk_mb']),
    dbMb: nullableInt(row['db_mb']),
    dbConnections: nullableInt(row['db_connections']),
  };
}

export class CapacityRepository implements CapacityStore {
  constructor(private readonly database: TenantDatabase) {}

  async insert(reading: CapacityReading): Promise<void> {
    await this.database.identityTransaction(
      { correlationId: uuidv7(), tables: ['host_capacity_readings'] },
      async (tx) => {
        await tx.query(INSERT_SQL, [
          uuidv7(),
          reading.takenAt,
          reading.source,
          reading.rssMb,
          reading.heapMb,
          reading.loopLagMs,
          reading.sockets,
          reading.inodes,
          reading.diskMb,
          reading.dbMb,
          reading.dbConnections,
        ]);
      },
    );
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    return this.database.identityTransaction(
      { correlationId: uuidv7(), tables: ['host_capacity_readings'] },
      async (tx) => {
        const result = await tx.query<ResultSetHeader>(
          'delete from host_capacity_readings where taken_at < ?',
          [cutoff],
        );
        return result.affectedRows;
      },
    );
  }

  /**
   * The schema's size (data + indexes) from `information_schema.TABLES` and the server's
   * `Threads_connected`. Identical on MySQL 8 and MariaDB. Each figure is null when unreadable.
   */
  async readDatabaseFigures(): Promise<DatabaseFigures> {
    return this.database.identityRead(
      { correlationId: uuidv7(), tables: ['host_capacity_readings'] },
      async (runner) => {
        let dbMb: number | null = null;
        let dbConnections: number | null = null;
        try {
          const rows = await runner.query<QueryRows>(
            'SELECT COALESCE(SUM(data_length + index_length), 0) AS b FROM information_schema.tables WHERE table_schema = DATABASE()',
          );
          dbMb = Math.round(Number(rows[0]?.['b'] ?? 0) / (1024 * 1024));
        } catch {
          dbMb = null;
        }
        try {
          const rows = await runner.query<QueryRows>("SHOW STATUS LIKE 'Threads_connected'");
          const value = Number(rows[0]?.['Value'] ?? rows[0]?.['value']);
          dbConnections = Number.isFinite(value) ? value : null;
        } catch {
          dbConnections = null;
        }
        return { dbMb, dbConnections };
      },
    );
  }

  async readProfileJson(): Promise<string | null> {
    return this.database.identityRead(
      { correlationId: uuidv7(), tables: ['platform_settings'] },
      async (runner) => {
        const rows = await runner.query<QueryRows>(
          'select setting_value from platform_settings where setting_key = ? limit 1',
          [HOST_PROFILE_SETTING_KEY],
        );
        const value = rows[0]?.['setting_value'];
        return typeof value === 'string' ? value : null;
      },
    );
  }

  async latest(source: CapacitySource): Promise<CapacityReading | null> {
    return this.database.identityRead(
      { correlationId: uuidv7(), tables: ['host_capacity_readings'] },
      async (runner) => {
        const rows = await runner.query<QueryRows>(
          `select ${COLUMNS} from host_capacity_readings where source = ? order by taken_at desc limit 1`,
          [source],
        );
        return rows[0] === undefined ? null : toReading(rows[0]);
      },
    );
  }

  async recentNightly(limit: number): Promise<CapacityReading[]> {
    return this.database.identityRead(
      { correlationId: uuidv7(), tables: ['host_capacity_readings'] },
      async (runner) => {
        const rows = await runner.query<QueryRows>(
          `select ${COLUMNS} from host_capacity_readings where source = 'nightly' order by taken_at desc limit ${Math.max(1, Math.min(100, Math.trunc(limit)))}`,
        );
        return rows.map(toReading);
      },
    );
  }
}
