import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection } from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { createMigrationConnection } from '../src/common/database/connection.js';
import {
  loadMigrations,
  migrate,
  migrationStatus,
  readLedger,
  resetDatabase,
} from '../src/common/database/migrator.js';
import { migrationsDirectory, startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * T1 TESTDB 2026-11-19 — the five migrations of this pass on the real engine (MariaDB 11.8.9),
 * and the one key-free 62-01 check that needs a database.
 *
 * 1. 0379–0383 apply on top of the shipped schema, each after a process was killed inside it
 *    (as Hostinger's deploy restart killed 0237 on 2026-10-26): the migrator resumes the file by
 *    itself, a second run applies nothing, and the schema it leaves equals a clean run's.
 * 2. 62-01 CHECK-P0: a `VECTOR(512)` column with an exact `VEC_DISTANCE_COSINE` scan inside one
 *    tenant (the 62-24 design: no vector index) is accepted by the migrator, by `check:mariadb`,
 *    and by a DML-only account, and ranks as cosine distance does.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPAT_SCRIPT = resolve(HERE, '../../../scripts/check-mariadb-compat.mjs');

/** The files of this pass and the tables each creates (plus the one column 0383 adds). */
const PASS_FILES: Readonly<Record<number, readonly string[]>> = {
  379: ['activity_entries', 'activity_projection_cursors'],
  380: ['work_signal_settings', 'work_signal_sweeps', 'work_signals'],
  381: ['ai_budget_pools', 'ai_member_periods', 'ai_workspace_periods'],
  382: ['ai_tasks', 'ai_usage_ledger'],
  383: ['ai_credit_packs', 'ai_workspace_settings'],
};
const FIRST_PASS_VERSION = 379;
const PASS_TABLES = [...Object.values(PASS_FILES).flat(), 'organization_limits'].sort();

let db: TestDatabase;
let connection: Connection;

beforeAll(async () => {
  db = await startTestDatabase({ applyMigrations: false, scratch: true });
  connection = await createMigrationConnection(db.url);
});

afterAll(async () => {
  await connection?.end();
  await db?.stop();
});

async function emptyDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function copyMigration(dir: string, filename: string): Promise<void> {
  await copyFile(join(migrationsDirectory, filename), join(dir, filename));
}

/**
 * Leave `version` as a process killed mid-file leaves it: statements `0 .. committed - 1` really
 * applied, the ledger row `running` with `recorded` of them counted (`committed - 1` = killed
 * between a DDL commit and its counter update, the release-night case).
 */
async function simulateKill(
  dir: string,
  version: number,
  committed: number,
  recorded: number,
): Promise<void> {
  const file = (await loadMigrations(dir)).find((f) => f.version === version);
  if (!file) throw new Error(`no file for version ${version}`);
  await migrationStatus(connection, dir);
  for (const statement of file.statements.slice(0, committed)) {
    await connection.query(statement);
  }
  await connection.execute(
    `INSERT INTO schema_migrations
       (version, name, checksum, status, statements_total, statements_applied,
        applied_by, started_at)
     VALUES (?, ?, ?, 'running', ?, ?, 'killed-process', NOW(3))`,
    [file.version, file.name, file.checksum, file.statements.length, recorded],
  );
}

async function createStatements(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of PASS_TABLES) {
    const [rows] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${table}\``);
    out[table] = String(rows[0]?.['Create Table']);
  }
  return out;
}

describe('0379–0383: up on 11.8.9, resumed after a mid-file stop, re-run is a no-op', () => {
  it('each file resumes by itself after a kill inside it, and the schema equals a clean run', async () => {
    const version = await connection.query<RowDataPacket[]>('SELECT VERSION() AS v');
    expect(String(version[0][0]?.['v'])).toMatch(/^11\.8\.9-MariaDB/);

    const all = (await readdir(migrationsDirectory)).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    const passFiles = all.filter((f) => Number(f.slice(0, 4)) >= FIRST_PASS_VERSION).sort();
    expect(passFiles.map((f) => Number(f.slice(0, 4)))).toEqual(
      Object.keys(PASS_FILES).map(Number),
    );

    // The shipped schema first: every file before this pass.
    const dir = await emptyDir('tmanage-t1-1119-mig-');
    for (const filename of all.filter((f) => Number(f.slice(0, 4)) < FIRST_PASS_VERSION)) {
      await copyMigration(dir, filename);
    }
    await migrate(connection, { directory: dir, appliedBy: 't1-1119' });

    // Then each pass file, killed inside it. Odd files lose the counter update of the statement
    // that landed (lag 1), even files stop cleanly after it (lag 0); 0383's kill lands after its
    // ALTER TABLE organization_limits ADD COLUMN, the statement a naive re-run would refuse.
    for (const filename of passFiles) {
      await copyMigration(dir, filename);
      const fileVersion = Number(filename.slice(0, 4));
      const file = (await loadMigrations(dir)).find((f) => f.version === fileVersion);
      const total = file?.statements.length ?? 0;
      expect(total).toBeGreaterThanOrEqual(2);
      const committed = fileVersion === 383 ? total : total - 1;
      const recorded = fileVersion % 2 === 1 ? committed - 1 : committed;
      await simulateKill(dir, fileVersion, committed, recorded);

      const report = await migrate(connection, { directory: dir, appliedBy: 't1-1119' });
      expect(report.resumed).toBe(fileVersion);
      const row = (await readLedger(connection)).find((r) => r.version === fileVersion);
      expect(row).toMatchObject({
        status: 'applied',
        statementsApplied: total,
        statementsTotal: total,
        failedStatementIndex: null,
      });
    }

    // Re-run: nothing pending, nothing applied.
    const again = await migrate(connection, { directory: dir, appliedBy: 't1-1119' });
    expect(again.applied).toEqual([]);
    expect(again.resumed).toBeNull();
    expect(again.alreadyApplied).toEqual(
      expect.arrayContaining(Object.keys(PASS_FILES).map(Number)),
    );

    const [limitColumn] = await connection.query<RowDataPacket[]>(
      `SELECT is_nullable AS n, data_type AS t FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'organization_limits'
          AND column_name = 'ai_credits_limit'`,
    );
    expect(limitColumn).toEqual([expect.objectContaining({ n: 'YES', t: 'int' })]);
    const resumed = await createStatements();

    // A clean run of the real directory leaves exactly the same tables.
    await resetDatabase(connection);
    await migrate(connection, { directory: migrationsDirectory, appliedBy: 't1-1119' });
    expect(await createStatements()).toEqual(resumed);
  });
});

// ── 62-01 CHECK-P0: VECTOR(512) + VEC_DISTANCE_COSINE ───────────────────────────────────────

const DIMENSIONS = 512;
const VECTOR_MIGRATION = `-- 62-01 scratch: the 62-24 store shape (exact scan inside the tenant, no vector index).
CREATE TABLE scratch_file_chunks (
  organization_id CHAR(36) NOT NULL,
  id CHAR(36) NOT NULL,
  project_id CHAR(36) NOT NULL,
  embedding VECTOR(${DIMENSIONS}) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_scratch_file_chunks_org_id (organization_id, id),
  KEY ix_scratch_file_chunks_scope (organization_id, project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const ORG_A = '00000000-0000-7000-8000-00000000000a';
const ORG_B = '00000000-0000-7000-8000-00000000000b';
const PROJECT = '00000000-0000-7000-8000-0000000000a1';
const OTHER_PROJECT = '00000000-0000-7000-8000-0000000000a2';
const DML_USER = 't1_vector_dml';
const DML_PASSWORD = 'local_dev_only_vector';

/** A deterministic unit-ish vector: a cosine of `angle` from the query in one plane. */
function vectorAt(angle: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  for (let i = 2; i < DIMENSIONS; i += 1) v[i] = ((i * 7919) % 13) / 1000;
  return v;
}

function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return 1 - dot / Math.sqrt(na * nb);
}

const text = (v: readonly number[]): string => `[${v.join(',')}]`;

describe('62-01: VECTOR(512) + VEC_DISTANCE_COSINE on 11.8.9 (key-free CHECK-P0)', () => {
  it('check:mariadb, the migrator and a DML-only account accept it; the scan ranks by cosine inside one tenant', async () => {
    const dir = await emptyDir('tmanage-t1-1119-vector-');
    await writeFile(join(dir, '0001_scratch_vectors.sql'), VECTOR_MIGRATION, 'utf8');

    // check:mariadb on the scratch directory: exit 0 = clean.
    const compat = execFileSync(process.execPath, [COMPAT_SCRIPT, dir], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    expect(compat).toMatch(/clean/i);

    await resetDatabase(connection);
    const report = await migrate(connection, { directory: dir, appliedBy: 't1-1119' });
    expect(report.applied.map((f) => f.version)).toEqual([1]);
    const [column] = await connection.query<RowDataPacket[]>(
      `SELECT column_type AS t FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'scratch_file_chunks'
          AND column_name = 'embedding'`,
    );
    expect(String(column[0]?.['t']).toLowerCase()).toBe(`vector(${DIMENSIONS})`);

    // A DML-only account: SELECT and INSERT on the one table, nothing else.
    const url = new URL(db.url);
    const database = url.pathname.replace(/^\//, '');
    await connection.query(`DROP USER IF EXISTS '${DML_USER}'@'%'`);
    await connection.query(`CREATE USER '${DML_USER}'@'%' IDENTIFIED BY '${DML_PASSWORD}'`);
    await connection.query(
      `GRANT SELECT, INSERT ON \`${database}\`.\`scratch_file_chunks\` TO '${DML_USER}'@'%'`,
    );
    const dml = await createConnection({
      host: url.hostname,
      port: Number(url.port),
      user: DML_USER,
      password: DML_PASSWORD,
      database,
    });
    try {
      const query = vectorAt(0);
      const angles = [0.1, 0.9, 0.4, 1.4, 0.2];
      const rows: [string, string, string, number][] = [
        ...angles.map((angle, i): [string, string, string, number] => [
          ORG_A,
          `00000000-0000-7000-8000-0000000001a${i}`,
          PROJECT,
          angle,
        ]),
        // Nearer than all of A's rows, but in another project and another tenant.
        [ORG_A, '00000000-0000-7000-8000-0000000001b0', OTHER_PROJECT, 0.01],
        [ORG_B, '00000000-0000-7000-8000-0000000001c0', PROJECT, 0],
      ];
      for (const [organizationId, id, projectId, angle] of rows) {
        await dml.execute(
          `INSERT INTO scratch_file_chunks (organization_id, id, project_id, embedding)
           VALUES (?, ?, ?, VEC_FromText(?))`,
          [organizationId, id, projectId, text(vectorAt(angle))],
        );
      }

      const [ranked] = await dml.execute<RowDataPacket[]>(
        `SELECT id, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS distance
           FROM scratch_file_chunks
          WHERE organization_id = ? AND project_id IN (?)
          ORDER BY distance
          LIMIT 3`,
        [text(query), ORG_A, PROJECT],
      );
      // Nearest first: angles 0.1, 0.2, 0.4 — never the other project's or tenant's rows.
      expect(ranked.map((r) => String(r['id']))).toEqual([
        '00000000-0000-7000-8000-0000000001a0',
        '00000000-0000-7000-8000-0000000001a4',
        '00000000-0000-7000-8000-0000000001a2',
      ]);
      const expected = [0.1, 0.2, 0.4].map((angle) => cosineDistance(query, vectorAt(angle)));
      ranked.forEach((r, i) => {
        // float32 storage: equal to the float64 figure to ~1e-6.
        expect(Number(r['distance'])).toBeCloseTo(expected[i] ?? Number.NaN, 5);
      });

      // The column refuses a vector of the wrong size.
      await expect(
        dml.execute(
          `INSERT INTO scratch_file_chunks (organization_id, id, project_id, embedding)
           VALUES (?, ?, ?, VEC_FromText(?))`,
          [ORG_A, '00000000-0000-7000-8000-0000000001d0', PROJECT, text([1, 0, 0])],
        ),
      ).rejects.toThrow();
      // And the DML-only account cannot change the schema.
      await expect(dml.query('DROP TABLE scratch_file_chunks')).rejects.toMatchObject({
        errno: 1142,
      });
    } finally {
      await dml.end();
      await connection.query(`DROP USER IF EXISTS '${DML_USER}'@'%'`);
    }
  });
});
