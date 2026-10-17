/**
 * Types for scripts/db/mariadb-server.mjs: private, throwaway MariaDB 11.8 servers for tests.
 * See the module header for why MariaDB, the template datadir and the server options.
 */

/** The pinned MariaDB release the bundled Windows runtime provides (production: 11.8.9). */
export const MARIADB_VERSION: '11.8.9';

export interface MariaDbRuntime {
  /** Install directory (contains `bin/`). */
  home: string;
  /** Directory holding `mariadbd[.exe]` and the client tools. */
  bin: string;
  /** Version reported by `mariadbd --version`, e.g. "11.8.9"; always 11.8.x. */
  version: string;
}

/**
 * Locates a MariaDB 11.8 runtime: TMANAGE_MARIADB_HOME, else on Windows the cache under
 * `<repo>/.local/mariadb` (extracted from the sha256-pinned official ZIP on first use), else
 * an 11.8 `mariadbd` on PATH. Rejects anything that is not 11.8.x.
 */
export function ensureMariaDbRuntime(): Promise<MariaDbRuntime>;

export interface StartMariaDbOptions {
  /** Database created on start (utf8mb4 / utf8mb4_unicode_ci). Default 'tmanage_test'. */
  dbName?: string;
  /** Fixed port; by default a free 127.0.0.1 port is chosen. */
  port?: number;
  /** How chatty the launcher itself is on stderr. Default 'ERROR' (silent unless it fails). */
  logLevel?: 'ERROR' | 'WARN' | 'LOG';
}

export interface MariaDbServer {
  port: number;
  /** Passwordless root on a 127.0.0.1-only, ephemeral server. */
  username: 'root';
  dbName: string;
  /** `mysql://root@127.0.0.1:<port>/<dbName>` */
  url: string;
  /** `SELECT VERSION()`, e.g. "11.8.9-MariaDB-log". */
  version: string;
  /** Shuts the server down and deletes its datadir. Idempotent. */
  stop(): Promise<void>;
}

export function startMariaDb(options?: StartMariaDbOptions): Promise<MariaDbServer>;
