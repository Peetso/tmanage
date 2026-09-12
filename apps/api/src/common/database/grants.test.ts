import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  allows,
  applyGrants,
  excessOf,
  missingOf,
  parseGrantScript,
  GrantApplicationError,
  ER_NONEXISTING_GRANT,
  ER_REVOKE_GRANTS,
} from './grants.js';
import type { GrantConnection } from './grants.js';

/**
 * The grant applier and the grant-script parser, without a server.
 *
 * These are the two pieces R10's fix rests on, and both are testable here: the applier must
 * treat "there was nothing to revoke" as success and everything else as failure, and the
 * parser must be able to say what the script intends precisely enough to be the *expected*
 * side of a security assertion. The assertion itself needs a database and lives in
 * `apps/api/test/grant-reconciliation.db.test.ts`; what runs in a second, on every commit,
 * is here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const USERS_SQL = resolve(HERE, '../../../../../scripts/db/users.sql');
const usersSql = readFileSync(USERS_SQL, 'utf8');

/** A connection that records what it was asked to run and fails the statements told to. */
function fakeConnection(failures: Map<number, { errno: number; message: string }>): {
  connection: GrantConnection;
  executed: string[];
} {
  const executed: string[] = [];
  let calls = 0;
  return {
    executed,
    connection: {
      query: async (sql: string) => {
        calls += 1;
        const failure = failures.get(calls);
        if (failure) {
          const error = new Error(failure.message) as Error & { errno: number };
          error.errno = failure.errno;
          throw error;
        }
        executed.push(sql);
        return undefined;
      },
    },
  };
}

const FRESH = `
CREATE USER IF NOT EXISTS 'tmanage_app'@'%' IDENTIFIED BY 'x';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'tmanage_app'@'%';
GRANT SELECT ON \`tmanage\`.* TO 'tmanage_app'@'%';
FLUSH PRIVILEGES;
`;

describe('applyGrants — the statement loop `pnpm db:grants` runs', () => {
  it('runs every statement in file order', async () => {
    const { connection, executed } = fakeConnection(new Map());
    const report = await applyGrants(connection, FRESH);
    expect(report.statements).toHaveLength(4);
    expect(report.noOpRevokes).toBe(0);
    expect(executed[0]).toMatch(/^CREATE USER/);
    expect(executed[1]).toMatch(/^REVOKE/);
    expect(executed[2]).toMatch(/^GRANT/);
    // The ordering is the correctness property, not an incidental: a REVOKE after its
    // GRANTs would leave the principal with nothing, and a REVOKE before its CREATE USER
    // would name an account that does not exist.
    expect(executed[3]).toMatch(/^FLUSH/);
  });

  it.each([
    ['ER_REVOKE_GRANTS (MariaDB on an empty account)', ER_REVOKE_GRANTS],
    ['ER_NONEXISTING_GRANT', ER_NONEXISTING_GRANT],
  ])('treats a revoke that finds nothing as a no-op: %s', async (_label, errno) => {
    // The fresh-database case, which must keep working. The account was created by the
    // statement immediately above, so this error cannot mean "unknown user".
    const { connection, executed } = fakeConnection(
      new Map([[2, { errno, message: "Can't revoke all privileges" }]]),
    );
    const report = await applyGrants(connection, FRESH);
    expect(report.noOpRevokes).toBe(1);
    expect(report.statements[1]?.outcome).toBe('no-op');
    // And the run continues: the grants after it are what the principal ends up with.
    expect(executed.some((sql) => /^GRANT SELECT/.test(sql))).toBe(true);
  });

  it('fails on any other error from a revoke, including a refusal', async () => {
    // The dangerous case. A revoke refused for lack of privilege leaves the old wide grant
    // in place — precisely R10's condition — so it must never be swallowed as a no-op.
    const { connection } = fakeConnection(
      new Map([[2, { errno: 1045, message: 'Access denied for user' }]]),
    );
    await expect(applyGrants(connection, FRESH)).rejects.toThrow(GrantApplicationError);
  });

  it('fails on a grant error even when it carries a tolerated errno', async () => {
    // The tolerance is scoped to REVOKE. A GRANT answering 1141 is not a no-op.
    const { connection } = fakeConnection(
      new Map([[3, { errno: ER_NONEXISTING_GRANT, message: 'no such grant' }]]),
    );
    await expect(applyGrants(connection, FRESH)).rejects.toMatchObject({ index: 3, total: 4 });
  });

  it('stops at the failing statement rather than pressing on', async () => {
    const { connection, executed } = fakeConnection(
      new Map([[1, { errno: 1227, message: 'Access denied; you need CREATE USER' }]]),
    );
    await expect(applyGrants(connection, FRESH)).rejects.toThrow(GrantApplicationError);
    expect(executed).toEqual([]);
  });
});

describe('parseGrantScript — what the real users.sql says each principal may hold', () => {
  const intents = parseGrantScript(usersSql);

  it('understands every statement in the file', () => {
    // parseGrantScript throws on anything it does not recognise, so reaching here is the
    // assertion. A parser that silently skipped a GRANT would turn an unchecked privilege
    // into a passing test.
    expect([...intents.keys()].sort()).toEqual([
      "'tmanage_app'@'%'",
      "'tmanage_migrator'@'%'",
      "'tmanage_worker'@'%'",
    ]);
  });

  it('revokes from every principal it grants to — the R10 property, statically', () => {
    // The finding in one line: before this, the file created accounts with IF NOT EXISTS
    // and never took anything away, so re-applying it to an installation provisioned by an
    // older revision left that revision's wider grants in force.
    for (const intent of intents.values()) {
      expect(intent.revokedFirst, `no REVOKE for ${intent.grantee}`).toBe(true);
    }
  });

  it('gives the worker fourteen table-level reads and no database-wide grant', () => {
    const worker = intents.get("'tmanage_worker'@'%'");
    const reads = [...(worker?.privileges ?? [])].filter((p) => p.endsWith(':SELECT'));
    expect(reads).toHaveLength(14);
    expect(reads.some((p) => p.startsWith('tmanage.*:'))).toBe(false);
  });

  it('states nothing at all for the worker on the four credential tables', () => {
    const worker = intents.get("'tmanage_worker'@'%'") as NonNullable<
      ReturnType<typeof intents.get>
    >;
    for (const table of [
      'user_passwords',
      'user_mfa_factors',
      'user_recovery_codes',
      'authentication_events',
    ]) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(
          allows(worker, `tmanage.${table}:${privilege}`),
          `worker is stated to hold ${privilege} on ${table}`,
        ).toBe(false);
      }
    }
  });

  it('lets the migrator own one schema and hold no global privilege', () => {
    const migrator = intents.get("'tmanage_migrator'@'%'") as NonNullable<
      ReturnType<typeof intents.get>
    >;
    // ALL PRIVILEGES is one token in the script and ~30 rows in information_schema, so the
    // comparison expands it — but only at the scope it was granted at.
    expect(allows(migrator, 'tmanage.*:DROP')).toBe(true);
    expect(allows(migrator, '*.*:CREATE USER')).toBe(false);
    expect(allows(migrator, 'other_db.*:SELECT')).toBe(false);
  });
});

describe('excessOf / missingOf — the comparison the verification makes', () => {
  const intents = parseGrantScript(usersSql);
  const worker = intents.get("'tmanage_worker'@'%'") as NonNullable<ReturnType<typeof intents.get>>;

  it('names a surviving database-wide SELECT as excess', () => {
    // Exactly the privilege R10 is about: the pre-D07 grant, still in force on a server
    // that has re-run an older users.sql. The verification must fail on this and nothing
    // about the fourteen narrow grants may hide it.
    expect(excessOf(worker, ['tmanage.*:SELECT', 'tmanage.outbox_events:SELECT'])).toEqual([
      'tmanage.*:SELECT',
    ]);
  });

  it('reports nothing as excess when the held set is the stated set', () => {
    expect(excessOf(worker, worker.privileges)).toEqual([]);
    expect(missingOf(worker, worker.privileges)).toEqual([]);
  });

  it('reports a privilege the script states but the server does not hold', () => {
    expect(missingOf(worker, [])).toContain('tmanage.outbox_events:SELECT');
  });
});
