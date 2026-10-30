import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/mysql-core';
import type { MySqlTable } from 'drizzle-orm/mysql-core';
import { describe, expect, it } from 'vitest';
import { TABLES } from './schema.js';
import { NON_TENANT_TABLES, TENANT_TABLES } from './tenant-guard.js';

/**
 * 56-04 — the tenant schema convention, asserted over `schema.ts` (SPEC 56 §56-04 "Data model").
 *
 * Every key of `TABLES` is placed in exactly one registry. A tenant table (`TENANT_TABLES`) carries
 * its tenant column as `CHAR(36) NOT NULL` and a unique key that starts `(organization_id, id)` —
 * the key every composite foreign key from a child row points at, and the reason a child can never
 * name a parent of another tenant. A global table is listed in `NON_TENANT_TABLES` instead. A table
 * in neither, or a tenant table without the composite key, fails with its name.
 *
 * The second half holds the migrations to `schema.ts`: a `CREATE TABLE` that `TABLES` does not
 * know is a migration whose author forgot the Drizzle definition, so no guard, no fixture and no
 * isolation corpus would ever see the table.
 */

/**
 * Tenant tables the composite-key rule does not apply to, each with the reason. A tenant table
 * with no `id` column at all is not listed here: its primary key must instead lead with the
 * tenant column (checked below), which addresses every row by tenant-leading columns.
 */
export const CONVENTION_EXCEPTIONS: Readonly<Record<string, string>> = {
  organizations: 'is the tenant: its tenant key is `id`, the primary key itself',
  product_events:
    '0251 metadata-only event sink (55-21): append-only, no child table references it and it has ' +
    'no foreign key by design (it must never block an organization purge), so no composite key ' +
    'is needed for a child to point at; follow-up: add uq (organization_id, id) when the purge lands',
  security_signals:
    '0263 detector signals (56-23): `organization_id` is NULLABLE by design — NULL is a platform ' +
    'signal no owner may read (org reads name their own id, NULL never matches); it keeps ' +
    'uq (organization_id, id), and no child table references it',
};

/** What the rule reads of a table, so a test can mutate it as plain data. */
export interface TableShape {
  readonly columns: readonly { name: string; sqlType: string; notNull: boolean }[];
  /** Unique indexes, unique constraints and primary keys, as ordered column-name lists. */
  readonly uniqueKeys: readonly (readonly string[])[];
  readonly primaryKeys: readonly (readonly string[])[];
}

export function shapeOf(table: MySqlTable): TableShape {
  const c = getTableConfig(table);
  const names = (cols: readonly { name: string }[]): string[] => cols.map((x) => x.name);
  const inlinePk = c.columns.filter((x) => x.primary).map((x) => [x.name]);
  return {
    columns: c.columns.map((x) => ({ name: x.name, sqlType: x.getSQLType(), notNull: x.notNull })),
    uniqueKeys: [
      ...c.indexes
        .filter((ix) => ix.config.unique)
        .map((ix) => names(ix.config.columns as { name: string }[])),
      ...c.uniqueConstraints.map((u) => names(u.columns)),
    ],
    primaryKeys: [...c.primaryKeys.map((pk) => names(pk.columns)), ...inlinePk],
  };
}

export interface ConventionInput {
  readonly tables: Readonly<Record<string, TableShape>>;
  readonly tenant: Readonly<Record<string, string>>;
  readonly global: readonly string[];
}

/** Every convention violation over a schema, as `table: reason` lines. */
export function conventionViolations(input: ConventionInput): string[] {
  const out: string[] = [];
  for (const [name, shape] of Object.entries(input.tables)) {
    const isTenant = Object.hasOwn(input.tenant, name);
    const isGlobal = input.global.includes(name);
    if (isTenant && isGlobal) out.push(`${name}: is in both TENANT_TABLES and NON_TENANT_TABLES`);
    if (!isTenant) {
      if (!isGlobal) out.push(`${name}: is in neither TENANT_TABLES nor NON_TENANT_TABLES`);
      continue;
    }
    if (CONVENTION_EXCEPTIONS[name] !== undefined) continue;
    const key = input.tenant[name] as string;
    const column = shape.columns.find((c) => c.name === key);
    if (column === undefined) {
      out.push(`${name}: has no ${key} column`);
      continue;
    }
    if (column.sqlType !== 'char(36)' || !column.notNull)
      out.push(`${name}: ${key} is ${column.sqlType}, not CHAR(36) NOT NULL`);
    const hasId = shape.columns.some((c) => c.name === 'id');
    const ok = hasId
      ? [...shape.uniqueKeys, ...shape.primaryKeys].some((k) => k[0] === key && k[1] === 'id')
      : shape.primaryKeys.some((k) => k[0] === key);
    if (!ok)
      out.push(
        hasId
          ? `${name}: has no unique key on (${key}, id)`
          : `${name}: has no id and its primary key does not lead with ${key}`,
      );
  }
  return out;
}

/** Every table a migration creates, lower-cased and sorted. */
export function migrationTables(sqlFiles: readonly string[]): string[] {
  const names = new Set<string>();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?`?([a-z0-9_]+)`?/gi;
  for (const sql of sqlFiles) {
    const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of code.matchAll(re)) names.add((m[1] as string).toLowerCase());
  }
  return [...names].sort();
}

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const LIVE: ConventionInput = {
  tables: Object.fromEntries(
    Object.entries(TABLES as unknown as Record<string, MySqlTable>).map(([n, t]) => [
      n,
      shapeOf(t),
    ]),
  ),
  tenant: TENANT_TABLES,
  global: NON_TENANT_TABLES,
};

describe('56-04 tenant schema convention', () => {
  it('places every table; every tenant table has CHAR(36) NOT NULL and (organization_id, id)', () => {
    const violations = conventionViolations(LIVE);
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('fails a tenant table that loses its composite unique key, or its registry entry', () => {
    const victim = 'oauth_grants';
    const shape = LIVE.tables[victim] as TableShape;
    const stripped: TableShape = {
      ...shape,
      uniqueKeys: shape.uniqueKeys.filter((k) => !(k[0] === 'organization_id' && k[1] === 'id')),
    };
    expect(
      conventionViolations({ ...LIVE, tables: { ...LIVE.tables, [victim]: stripped } }),
    ).toEqual([`${victim}: has no unique key on (organization_id, id)`]);
    const tenant = Object.fromEntries(Object.entries(LIVE.tenant).filter(([n]) => n !== victim));
    expect(conventionViolations({ ...LIVE, tenant })).toEqual([
      `${victim}: is in neither TENANT_TABLES nor NON_TENANT_TABLES`,
    ]);
  });

  it('knows every table a migration creates', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    const created = migrationTables(files.map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8')));
    expect(created.length).toBeGreaterThan(100);
    const known = new Set(Object.keys(TABLES));
    const missing = created.filter((t) => !known.has(t));
    expect(missing, `CREATE TABLE without a schema.ts entry: ${missing.join(', ')}`).toEqual([]);
  });
});
