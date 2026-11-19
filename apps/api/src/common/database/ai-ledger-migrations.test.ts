import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isDataStatement, splitStatements } from './migrator.js';

/**
 * Plan 62, slice 62-05 (B08): the AI ledger migrations 0381–0383 as files, before any database
 * runs them. Each statement is one DDL (so an interrupted deploy resumes at the statement the
 * counter missed), nothing writes data, and every tenant table carries its tenant column and the
 * `(organization_id, id)` key the tenant guard and composite references rely on. The MariaDB
 * syntax check itself is `pnpm check:mariadb`; running them on MariaDB is the DB test phase.
 */

const MIGRATIONS = fileURLToPath(new URL('../../../migrations/', import.meta.url));

const FILES = {
  '0381_ai_budget_pools_periods.sql': [
    'ai_budget_pools',
    'ai_workspace_periods',
    'ai_member_periods',
  ],
  '0382_ai_usage_ledger_tasks.sql': ['ai_tasks', 'ai_usage_ledger'],
  '0383_ai_settings_packs_limit.sql': ['ai_workspace_settings', 'ai_credit_packs'],
} as const;

/** The one platform table: the pools are shared by every workspace by design. */
const PLATFORM_TABLES: readonly string[] = ['ai_budget_pools'];

async function statementsOf(file: string): Promise<string[]> {
  return splitStatements(await readFile(join(MIGRATIONS, file), 'utf8'));
}

describe('AI ledger migrations 0381–0383', () => {
  it.each(Object.entries(FILES))(
    '%s creates exactly its tables, one DDL per statement',
    async (file, tables) => {
      const statements = await statementsOf(file);
      const created = statements.flatMap((sql) => /^CREATE TABLE (\w+) \(/.exec(sql)?.[1] ?? []);
      expect(created).toEqual(tables);
      for (const sql of statements) {
        expect(sql, sql.slice(0, 60)).toMatch(
          /^(CREATE TABLE \w+ \(|ALTER TABLE \w+\s+ADD COLUMN )/,
        );
        expect(isDataStatement(sql)).toBe(false);
        expect(sql).not.toMatch(/\bFOREIGN KEY\b|\bGENERATED\b|\bCHECK\s*\(|\bTRIGGER\b/i);
      }
    },
  );

  it('every tenant table has organization_id and a unique (organization_id, id) key', async () => {
    const statements = (await Promise.all(Object.keys(FILES).map(statementsOf))).flat();
    const tenantTables = statements.filter(
      (sql) =>
        sql.startsWith('CREATE TABLE') &&
        !PLATFORM_TABLES.includes(/^CREATE TABLE (\w+)/.exec(sql)?.[1] ?? ''),
    );
    expect(tenantTables).toHaveLength(6);
    for (const sql of tenantTables) {
      const table = /^CREATE TABLE (\w+)/.exec(sql)?.[1] ?? '';
      expect(sql).toMatch(/\n\s+organization_id\s+CHAR\(36\)\s+NOT NULL,/);
      expect(sql).toContain(`UNIQUE KEY uq_${table}_org_id (organization_id, id)`);
    }
  });

  it('adds the per-workspace credit limit as a nullable column (NULL = the plan value)', async () => {
    const statements = await statementsOf('0383_ai_settings_packs_limit.sql');
    expect(statements.at(-1)).toBe(
      'ALTER TABLE organization_limits\n  ADD COLUMN ai_credits_limit INT NULL AFTER storage_bytes_limit',
    );
  });

  it('keeps money in integer micro-USD and credits in whole numbers', async () => {
    const sql = (await Promise.all(Object.keys(FILES).map(statementsOf))).flat().join('\n');
    for (const column of sql.match(/^\s+\w*micro_usd\s+\S+(?: \S+)?/gm) ?? []) {
      expect(column).toMatch(/BIGINT UNSIGNED/);
    }
    for (const column of sql.match(/^\s+\w*_credits\s+\S+(?: \S+)?/gm) ?? []) {
      expect(column).toMatch(/INT UNSIGNED/);
    }
    expect(sql).not.toMatch(/\b(DECIMAL|FLOAT|DOUBLE)\b/i);
  });
});
