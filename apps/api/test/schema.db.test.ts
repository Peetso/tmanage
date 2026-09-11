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
 * Reduce a Drizzle SQL type and a MySQL `COLUMN_TYPE` to a comparable form.
 *
 * The equivalences below are real facts, each one deliberate rather than a way to make a
 * comparison pass:
 *
 * - Drizzle's `boolean()` emits `boolean`, which MySQL stores as `tinyint(1)`. There is no
 *   separate boolean type. The `(1)` is kept, because for `tinyint` the width is how a
 *   boolean is spelled rather than noise.
 * - `bigint unsigned` and `bigint(20) unsigned` differ only by the display width, which
 *   MySQL 8.0.19 deprecated and stopped reporting. The same holds for `int(10)`,
 *   `mediumint(8)` and `smallint(5)`.
 * - `longtext` reduces to `json`. On MySQL a `json` column reports `json`, so this does not
 *   fire; it is kept as a tolerance for a server that stores JSON as text, and it is safe
 *   because the only such columns in this schema are `audit_events.metadata_json`,
 *   `idempotency_records.response_json` and `outbox_events.payload_json`, all genuine JSON.
 *
 * The width branch was wrong until 2026-08-25: it dropped the space as well as the width,
 * turning `bigint(20) unsigned` into `bigintunsigned`, and it tested `startsWith('int')` so
 * `smallint` and `mediumint` were missed entirely. MySQL never reports a display width, so
 * on the engine this project actually runs the branch does not execute at all.
 */
function normaliseType(type: string): string {
  const lowered = type.toLowerCase().replace(/\s+/g, ' ').trim();
  if (lowered === 'boolean' || lowered === 'tinyint') return 'tinyint(1)';
  if (lowered === 'longtext') return 'json';
  return lowered.replace(/^(bigint|mediumint|smallint|int)\(\d+\)/, '$1');
}

/** Types where MySQL and Drizzle genuinely agree once width noise is removed. */
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
