import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { createTenantPool } from './connection.js';
import { TenantDatabase } from './tenant-context.js';
import type { TenantGuardEvent, TenantGuardMode } from './tenant-guard.js';
import { ERASURE_DATABASE, TENANT_DATABASE } from '../http/tokens.js';

/**
 * Where the process's `TenantDatabase` is registered (and the company erasure's, on its own
 * credential where one is configured) — and the only module that may hold a pool.
 *
 * This file lives under `src/common/database/`, which is the allowlisted directory in
 * ADR-0001 layer 4. That is why **both** entry points below are here rather than in
 * `main.ts`: the composition root asked for a `Pool` in an earlier draft of this work and the
 * lint boundary rejected it, correctly. Moving pool construction in here rather than widening
 * the allowlist keeps the rule meaning what it says — a driver handle exists in the database
 * layer and nowhere else — and leaves `main.ts` free of any knowledge that a connection pool
 * is involved at all.
 *
 * `@Global` because otherwise every feature module would import a database module to reach it,
 * and a module graph in which every node depends on the database is one where the dependency
 * has stopped carrying information.
 */
export interface DatabaseModuleOptions {
  readonly guardMode: TenantGuardMode;
  /** Security-event sink for ADR-0001 layer 3. Never receives a bound value. */
  readonly onGuardEvent?: (event: TenantGuardEvent) => void;
}

export interface DatabaseUrlOptions extends DatabaseModuleOptions {
  readonly url: string;
  /**
   * The company erasure's own credential (`tmanage_erasure`, H3). Absent: the erasure runs on the
   * runtime pool, which is what a single-user host (Hostinger) has.
   */
  readonly erasureUrl?: string;
  readonly connectionLimit: number;
  readonly statementTimeoutMs: number;
  readonly onConnectionError?: (error: unknown) => void;
}

@Global()
@Module({})
export class DatabaseModule {
  /**
   * Build the pool from a connection URL. The production path.
   */
  static forUrl(options: DatabaseUrlOptions): DynamicModule {
    const pool = (url: string, connectionLimit: number): Pool =>
      createTenantPool({
        url,
        connectionLimit,
        statementTimeoutMs: options.statementTimeoutMs,
        ...(options.onConnectionError ? { onConnectionError: options.onConnectionError } : {}),
      });
    return DatabaseModule.forPool({
      ...options,
      pool: pool(options.url, options.connectionLimit),
      // One connection: the erasure issues one statement at a time.
      ...(options.erasureUrl === undefined ? {} : { erasurePool: pool(options.erasureUrl, 1) }),
    });
  }

  /**
   * Wrap a pool the caller already owns.
   *
   * The database suite's path: its embedded MySQL server already has a pool, with the
   * least-privilege credential applied where CI supplies one. Constructing a second one here
   * would either start another server or quietly reach past the harness that decides which
   * credential the application runs as.
   */
  static forPool(
    options: DatabaseModuleOptions & { readonly pool: Pool; readonly erasurePool?: Pool },
  ): DynamicModule {
    const tenantDatabase = (pool: Pool): TenantDatabase =>
      new TenantDatabase(pool, {
        guardMode: options.guardMode,
        ...(options.onGuardEvent ? { onGuardEvent: options.onGuardEvent } : {}),
      });
    const database = tenantDatabase(options.pool);
    const providers: Provider[] = [
      { provide: TENANT_DATABASE, useValue: database },
      {
        provide: ERASURE_DATABASE,
        useValue: options.erasurePool ? tenantDatabase(options.erasurePool) : database,
      },
    ];

    return { module: DatabaseModule, providers, exports: providers };
  }
}
