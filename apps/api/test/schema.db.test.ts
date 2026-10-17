import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2/promise';
import { TABLES } from '../src/common/database/schema.js';
import { startTestDatabase } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';

/**
 * The Drizzle schema against the database the migrations actually produced.
 *
 * `schema.ts` is a *description*, not a definition — the migrations create everything, and
 * Drizzle is only used to build queries. That split buys reviewable, checksummed SQL and
 * keeps composite tenant foreign keys and the immutability triggers expressible, but it
 * costs one thing: two descriptions of one schema, free to drift.
 *
 * Drift here is not cosmetic. A column this file believes is `NOT NULL` but which is
 * nullable in the database produces a repository that returns `T` where the value can be
 * `null`, with no error anywhere — TypeScript believes the schema. A column name that has
 * been renamed in a migration produces `Unknown column` at runtime, in whichever
 * environment ran the migration first.
 *
 * So the two are compared against a migrated server on every database run.
 */

let db: TestDatabase;

interface ColumnRow extends RowDataPacket {
  readonly TABLE_NAME: string;
  readonly COLUMN_NAME: string;
  readonly IS_NULLABLE: 'YES' | 'NO';
  readonly COLUMN_TYPE: string;
}

let columnsByTable: Map<string, Map<string, ColumnRow>>;

/**
 * Reduce a Drizzle SQL type and a MariaDB `COLUMN_TYPE` to a comparable form.
 *
 * The equivalences below are real facts, each one deliberate rather than a way to make a
 * comparison pass:
 *
 * - Drizzle's `boolean()` emits `boolean`, which MariaDB stores as `tinyint(1)`. There is
 *   no separate boolean type. The `(1)` is kept, because for `tinyint` the width is how a
 *   boolean is spelled rather than noise.
 * - `bigint unsigned` and `bigint(20) unsigned` differ only by the display width, which
 *   MariaDB 11.8 reports on every integer column: `int(10)`, `mediumint(8)`,
 *   `smallint(5)`, `tinyint(4)` and `tinyint(3) unsigned` all reduce to the bare type.
 *   A plain Drizzle `tinyint()` is a number, not a boolean, so it is not equated with
 *   `tinyint(1)` (before 2026-10-17 it was, which only passed because the engine the
 *   harness ran then reported a plain `tinyint` without a width).
 * - `longtext` reduces to `json`. MariaDB's `JSON` is an alias for `LONGTEXT` guarded by
 *   an automatic `json_valid` CHECK, so every `json` column reports `longtext`. What
 *   makes the reduction safe is a rule, not a list: **every `json` column in this schema
 *   holds genuine JSON, and no column anywhere is declared `longtext`.** So it can only
 *   ever equate a `json` column with itself, and it stays safe as columns are added.
 *   Stated as a rule deliberately — until 2026-09-12 this named three columns by hand and
 *   there were already six, `messages.body_rich` and `message_revisions.body_rich`
 *   (migration `0008_message_rich_text.sql`) and `upload_sessions.upload_targets_json`
 *   (`0015_file_uploads.sql`) having landed after the list was written.
 *
 * The width branch was wrong until 2026-08-25: it dropped the space as well as the width,
 * turning `bigint(20) unsigned` into `bigintunsigned`, and it tested `startsWith('int')` so
 * `smallint` and `mediumint` were missed entirely.
 */
function normaliseType(type: string): string {
  const lowered = type.toLowerCase().replace(/\s+/g, ' ').trim();
  if (lowered === 'boolean') return 'tinyint(1)';
  if (lowered === 'longtext') return 'json';
  // MariaDB reports the display width: `tinyint(4)`, `tinyint(3) unsigned`, `int(10)`.
  // `tinyint(1)` is the one width that carries meaning (a boolean), so it alone is kept.
  return lowered
    .replace(/^(bigint|mediumint|smallint|int)\(\d+\)/, '$1')
    .replace(/^tinyint\((?!1\))\d+\)/, 'tinyint');
}

/** Types where MariaDB and Drizzle genuinely agree once width noise is removed. */
function typesAgree(drizzleType: string, columnType: string): boolean {
  // No width-stripping fallback. An earlier revision compared the two forms again with
  // every `(N)` removed, which made `smallint(5) unsigned` agree with `smallint unsigned`
  // — but by the same rule it made `varchar(255)` agree with `varchar(64)`, so a column
  // widened or narrowed by a migration would have passed silently. `normaliseType` now
  // handles the widths that are genuinely noise, so the comparison can be exact.
  return normaliseType(drizzleType) === normaliseType(columnType);
}

beforeAll(async () => {
  db = await startTestDatabase();
  const [rows] = await db.admin.query<ColumnRow[]>(
    `select table_name as TABLE_NAME, column_name as COLUMN_NAME,
            is_nullable as IS_NULLABLE, column_type as COLUMN_TYPE
       from information_schema.columns
      where table_schema = database()`,
  );
  columnsByTable = new Map();
  for (const row of rows) {
    const table = columnsByTable.get(row.TABLE_NAME) ?? new Map<string, ColumnRow>();
    table.set(row.COLUMN_NAME, row);
    columnsByTable.set(row.TABLE_NAME, table);
  }
});

afterAll(async () => {
  await db?.stop();
});

describe('the Drizzle schema describes the migrated database', () => {
  it('names every table the migrations create, and no others', () => {
    const described = Object.keys(TABLES).sort();
    // `schema_migrations` is the migrator's own ledger. It is deliberately absent from the
    // Drizzle schema: no repository may read or write it, and describing it would make
    // that possible.
    const actual = [...columnsByTable.keys()].filter((t) => t !== 'schema_migrations').sort();
    expect(described).toEqual(actual);
  });

  it('declares each table under its real SQL name', () => {
    for (const [key, table] of Object.entries(TABLES)) {
      expect(getTableName(table), `TABLES['${key}'] is mapped to the wrong table`).toBe(key);
    }
  });

  for (const [tableName, table] of Object.entries(TABLES)) {
    describe(tableName, () => {
      it('has exactly the columns the database has', () => {
        const described = Object.values(getTableColumns(table))
          .map((column) => column.name)
          .sort();
        const actual = [...(columnsByTable.get(tableName)?.keys() ?? [])].sort();
        expect(described).toEqual(actual);
      });

      it('agrees with the database on nullability', () => {
        for (const column of Object.values(getTableColumns(table))) {
          const actual = columnsByTable.get(tableName)?.get(column.name);
          expect(actual, `${tableName}.${column.name} is missing`).toBeDefined();
          // The direction that matters: `notNull` in TypeScript over a nullable column
          // means the type system promises a value the database does not.
          expect(
            column.notNull,
            `${tableName}.${column.name}: schema says notNull=${column.notNull}, database says IS_NULLABLE=${actual?.IS_NULLABLE}`,
          ).toBe(actual?.IS_NULLABLE === 'NO');
        }
      });

      it('agrees with the database on column types', () => {
        for (const column of Object.values(getTableColumns(table))) {
          const actual = columnsByTable.get(tableName)?.get(column.name);
          expect(
            typesAgree(column.getSQLType(), actual?.COLUMN_TYPE ?? ''),
            `${tableName}.${column.name}: schema says '${column.getSQLType()}', database says '${actual?.COLUMN_TYPE}'`,
          ).toBe(true);
        }
      });
    });
  }
});
