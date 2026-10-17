import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/check-mariadb-compat.mjs` — the fast, offline guard that keeps SQL MariaDB 11.8 does
 * not accept out of the migrations. MariaDB 11.8 is the only engine (production, local, CI and
 * the DB suite); this guard answers in seconds, before the 30-minute DB suite would. The script is
 * plain Node ESM and is run here as a child process (the api tsconfig does not import .mjs).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-mariadb-compat.mjs');

type Run = { status: number; output: string };

function runOn(dir?: string): Run {
  const args = dir === undefined ? [SCRIPT] : [SCRIPT, dir];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output: stdout };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, output: `${failed.stdout}${failed.stderr}` };
  }
}

const tempDirs: string[] = [];

function fixture(name: string, sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mariadb-compat-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, name), sql);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-mariadb-compat keeps MariaDB-incompatible SQL out of migrations', () => {
  it('passes a portable migration', () => {
    const dir = fixture(
      '0001_clean.sql',
      [
        'CREATE TABLE t (',
        '  id BINARY(16) NOT NULL,',
        '  doc JSON NULL,',
        '  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),',
        '  CONSTRAINT t_doc_ck CHECK (doc IS NULL OR JSON_VALID(doc)),',
        '  PRIMARY KEY (id)',
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;',
      ].join('\n'),
    );
    const run = runOn(dir);
    expect(run.status).toBe(0);
    expect(run.output).toContain('mariadb-compat: 1 files clean');
  });

  it('fails a generated column built on IF(), naming the file and line', () => {
    const dir = fixture(
      '0011_bad.sql',
      [
        'CREATE TABLE t (',
        '  a INT NULL,',
        '  b INT NOT NULL,',
        '  open_b INT GENERATED ALWAYS AS (IF(a IS NULL, b, NULL)) STORED',
        ');',
      ].join('\n'),
    );
    const run = runOn(dir);
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/0011_bad\.sql:4: GENERATED ALWAYS AS/);
  });

  it('fails a utf8mb4_0900_* collation', () => {
    const dir = fixture(
      '0026_bad.sql',
      'ALTER TABLE t MODIFY c VARCHAR(10) COLLATE utf8mb4_0900_bin;',
    );
    const run = runOn(dir);
    expect(run.status).toBe(1);
    expect(run.output).toMatch(/0026_bad\.sql:1: utf8mb4_0900_/);
  });

  it('ignores forbidden text inside comments and string literals', () => {
    const dir = fixture(
      '0002_prose.sql',
      [
        '-- was GENERATED ALWAYS AS (IF(a IS NULL, b, NULL)) STORED, utf8mb4_0900_bin',
        "INSERT INTO notes (body) VALUES ('GENERATED ALWAYS AS utf8mb4_0900_bin -> it''s fine');",
      ].join('\n'),
    );
    const run = runOn(dir);
    expect(run.status).toBe(0);
  });

  it('the real apps/api/migrations directory is clean', () => {
    // Green once the MariaDB rewrites of 0011, 0026, 0150 and 0153 land (triggers instead of
    // generated columns; no 0900 collation). If this is red, the output names each hit.
    const run = runOn();
    expect(run.output).toMatch(/mariadb-compat: \d+ files clean/);
    expect(run.status).toBe(0);
  });
});
