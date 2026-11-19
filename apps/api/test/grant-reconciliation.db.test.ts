import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, createPool } from 'mysql2/promise';
import type { Connection, Pool, RowDataPacket } from 'mysql2/promise';
import {
  applyGrants,
  excessOf,
  missingOf,
  parseGrantScript,
} from '../src/common/database/grants.js';
import type { PrincipalIntent } from '../src/common/database/grants.js';

/**
 * R10 — does re-applying `scripts/db/users.sql` actually *narrow* privileges?
 *
 * ## What this file is for
 *
 * `apps/api/src/common/database/users-sql.test.ts` asserts what the **script says**.
 * `apps/api/test/least-privilege.db.test.ts` asserts what a correctly provisioned
 * **account** is refused. Neither could see R10, and the reason is worth stating because it
 * is the general shape of the miss: both take the script's grants as the description of the
 * account. R10 is the case where they differ — an account provisioned by an *older* revision
 * of the script holds privileges no current statement mentions, so a test that reads only
 * the current statements cannot find them, and a test that connects to a *freshly created*
 * account never has them.
 *
 * The check this file adds is therefore neither of those. It reads the privileges **actually
 * in force on the server** and fails if any principal holds more than the script states. It
 * is the only assertion in the repository whose expected value comes from the file and whose
 * actual value comes from the server's own grant tables.
 *
 * ## The honest limits, named rather than discovered
 *
 * 1. **This suite runs as an administrative user on the development machine.** A missing
 *    grant is therefore invisible to `pnpm test:db` here — the runtime pool falls back to
 *    the admin credential when `TMANAGE_TEST_APP_DATABASE_URL` is absent, which is the
 *    normal local case. Nothing in this file changes that. A true least-privilege proof
 *    needs a server that has been provisioned with these three accounts, and this file
 *    skips loudly rather than reporting a pass it did not earn.
 * 2. **§2's reconciliation runs against renamed probe accounts, not the live three.** It
 *    revokes and rebuilds privileges, and doing that to `tmanage_app` on a shared server
 *    would disarm whatever else is connected as it. The statements exercised are the file's
 *    own, with only the principal names substituted, so the property proved — *old wide
 *    grant in, exact stated set out* — is the file's property. What it does not prove is
 *    that the live accounts on that particular server are correct; that is §1, which is
 *    read-only and says so.
 * 3. **A `REVOKE` that the server refuses is the failure mode to watch.** It leaves the old
 *    grant in place, which is R10 again with a green command. `applyGrants` fails on it;
 *    only the two "nothing to revoke" errnos are tolerated, and `grants.test.ts` pins that.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const USERS_SQL = resolve(HERE, '../../../scripts/db/users.sql');
const usersSql = readFileSync(USERS_SQL, 'utf8');

/**
 * An administrative URL: `CREATE USER`, `GRANT OPTION`, and `SELECT` on the `mysql` schema.
 *
 * A separate variable from `TMANAGE_TEST_DATABASE_URL` on purpose. That one may legitimately
 * name a credential that owns one database and nothing else; this one must be able to
 * provision accounts, which is exactly the authority `users.sql` says the applying credential
 * needs and `tmanage_migrator` is refused for.
 */
const ADMIN_URL = process.env['TMANAGE_TEST_GRANT_ADMIN_DATABASE_URL'];
const configured = ADMIN_URL !== undefined && ADMIN_URL !== '';

/** The database `users.sql` grants on. Every scope below is read relative to this name. */
const DATABASE = 'tmanage';

const HOW_TO_RUN =
  'To run it, point TMANAGE_TEST_GRANT_ADMIN_DATABASE_URL at an administrative ' +
  'credential (CREATE USER + GRANT OPTION + SELECT on `mysql`) for a server whose ' +
  '`tmanage` database has had `pnpm db:migrate` applied, then run:\n' +
  '  pnpm --filter @tmanage/api test -- --project database --run ' +
  'test/grant-reconciliation.db.test.ts';

/** `information_schema` spells a grantee `'user'@'host'`; so does `parseGrantScript`. */
const granteeOf = (user: string, host = '%'): string => `'${user}'@'${host}'`;

/**
 * Every privilege the server currently holds for `grantee`, at every scope, as the same
 * `db.table:PRIVILEGE` keys `parseGrantScript` produces.
 *
 * Read from `information_schema` rather than parsed out of `SHOW GRANTS`: the rows are
 * already one privilege per scope, so nothing here has to interpret `ALL PRIVILEGES`,
 * `WITH GRANT OPTION` or a role line, and a privilege this project has never heard of still
 * arrives as a row and still counts as excess.
 */
async function heldPrivileges(admin: Connection, grantee: string): Promise<string[]> {
  const held: string[] = [];

  const [globals] = await admin.query<RowDataPacket[]>(
    'select privilege_type as p from information_schema.user_privileges where grantee = ?',
    [grantee],
  );
  for (const row of globals) {
    // USAGE is MariaDB's spelling of "no privileges"; every account has it and it grants
    // nothing, so counting it would make every principal permanently in excess.
    if (String(row['p']).toUpperCase() === 'USAGE') continue;
    held.push(`*.*:${String(row['p']).toUpperCase()}`);
  }

  const [schemas] = await admin.query<RowDataPacket[]>(
    'select table_schema as s, privilege_type as p from information_schema.schema_privileges ' +
      'where grantee = ?',
    [grantee],
  );
  for (const row of schemas) {
    held.push(`${String(row['s'])}.*:${String(row['p']).toUpperCase()}`);
  }

  const [tables] = await admin.query<RowDataPacket[]>(
    'select table_schema as s, table_name as t, privilege_type as p ' +
      'from information_schema.table_privileges where grantee = ?',
    [grantee],
  );
  for (const row of tables) {
    held.push(`${String(row['s'])}.${String(row['t'])}:${String(row['p']).toUpperCase()}`);
  }

  const [columns] = await admin.query<RowDataPacket[]>(
    'select table_schema as s, table_name as t, column_name as c, privilege_type as p ' +
      'from information_schema.column_privileges where grantee = ?',
    [grantee],
  );
  for (const row of columns) {
    // `users.sql` grants no column privilege at all, so any row here is excess by
    // construction — spelled out rather than dropped, so the failure names the column.
    held.push(
      `${String(row['s'])}.${String(row['t'])}(${String(row['c'])}):${String(
        row['p'],
      ).toUpperCase()}`,
    );
  }

  return held.sort();
}

const intents = parseGrantScript(usersSql);

const intentFor = (user: string): PrincipalIntent => {
  const intent = intents.get(granteeOf(user));
  if (!intent) throw new Error(`scripts/db/users.sql does not define '${user}'`);
  return intent;
};

describe('R10 — the privileges in force match the privileges the script states', () => {
  it('guards CI against a silent skip', () => {
    if (process.env['CI']) {
      expect(
        configured,
        'TMANAGE_TEST_GRANT_ADMIN_DATABASE_URL must be set in CI: without it every case ' +
          'in this file is skipped, and R10 — whether re-applying scripts/db/users.sql ' +
          'removes an installation’s older, wider grants — stays unverified while the ' +
          'suite reports green',
      ).toBe(true);
    } else if (!configured) {
      console.warn(`[grant reconciliation] skipped — no administrative URL. ${HOW_TO_RUN}`);
    }
  });
});

const withAdmin = describe.skipIf(!configured);

// ─────────────────────────────────────────────────────────────────────────────
// §1 · The live accounts, read-only
// ─────────────────────────────────────────────────────────────────────────────

/** Every principal `users.sql` provisions. */
const LIVE_PRINCIPALS = ['tmanage_app', 'tmanage_worker', 'tmanage_migrator', 'tmanage_erasure'];

withAdmin('§1 · the live principals hold no more than the script states', () => {
  let admin: Connection;

  beforeAll(async () => {
    admin = await createConnection({ uri: ADMIN_URL as string, multipleStatements: false });
  });

  afterAll(async () => {
    await admin?.end();
  });

  for (const user of LIVE_PRINCIPALS) {
    it(`'${user}' holds nothing beyond its stated set`, async () => {
      const intent = intentFor(user);
      const held = await heldPrivileges(admin, granteeOf(user));

      // Zero rows anywhere means the account is absent from this server, or invisible to
      // this credential. Either way the emptiness below would be a pass that proves
      // nothing, so it is a failure with the reason named.
      expect(
        held.length,
        `no privilege rows at all for ${granteeOf(user)} — either the account is not ` +
          'provisioned on this server (run `pnpm db:grants`), or ' +
          'TMANAGE_TEST_GRANT_ADMIN_DATABASE_URL cannot read other accounts’ privileges. ' +
          'An empty result is not evidence of least privilege.',
      ).toBeGreaterThan(0);

      // The assertion R10 is about. On a server provisioned by the pre-R10 script and
      // re-granted since, `tmanage_worker` fails here on `tmanage.*:SELECT` — the
      // database-wide read that the fourteen narrow grants were supposed to replace and,
      // without a REVOKE, merely joined.
      expect(
        excessOf(intent, held),
        `${granteeOf(user)} holds privileges scripts/db/users.sql does not state`,
      ).toEqual([]);
    });
  }

  it('the worker can reach none of the four credential tables', async () => {
    // Stated separately from the excess check above because this is the sentence the status
    // record makes, and it should fail on its own terms rather than as one line of a diff.
    const held = await heldPrivileges(admin, granteeOf('tmanage_worker'));
    for (const table of [
      'user_passwords',
      'user_mfa_factors',
      'user_recovery_codes',
      'authentication_events',
    ]) {
      expect(
        held.filter((privilege) => privilege.startsWith(`${DATABASE}.${table}`)),
        `'tmanage_worker' holds a privilege on '${table}'`,
      ).toEqual([]);
      // And not by way of a database-wide grant either, which is how it held them before.
      expect(held.filter((privilege) => privilege.startsWith(`${DATABASE}.*:`))).toEqual([]);
    }
  });

  it('every principal also holds everything the script states', async () => {
    // The other half, and the reason this is a reconciliation rather than a ceiling: a
    // REVOKE that ran while the GRANTs after it did not is an outage, and it would pass
    // every assertion above.
    for (const user of LIVE_PRINCIPALS) {
      const held = await heldPrivileges(admin, granteeOf(user));
      expect(
        missingOf(intentFor(user), held),
        `${granteeOf(user)} is missing privileges scripts/db/users.sql grants it`,
      ).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 · The upgrade path itself, on isolated probe accounts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `users.sql` with its principal names substituted, so the reconciliation can revoke
 * and rebuild without touching an account something else on the server is connected as.
 *
 * A textual substitution of the quoted `'name'@'%'` and nothing else: every `CREATE USER`,
 * `REVOKE` and `GRANT` in the file is exercised exactly as written, in file order, against
 * the real `tmanage` tables.
 */
const PROBE_SUFFIX = `r10_${process.pid}`;
const PROBE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['tmanage_app', `tm_app_${PROBE_SUFFIX}`],
  ['tmanage_worker', `tm_wrk_${PROBE_SUFFIX}`],
  ['tmanage_migrator', `tm_mig_${PROBE_SUFFIX}`],
  ['tmanage_erasure', `tm_era_${PROBE_SUFFIX}`],
];

function probeScript(): string {
  let rewritten = usersSql;
  for (const [real, probe] of PROBE_NAMES) {
    rewritten = rewritten.split(`'${real}'@'%'`).join(`'${probe}'@'%'`);
  }
  return rewritten;
}

withAdmin('§2 · applying the script to an installation that holds the old wide grants', () => {
  let admin: Connection;
  const probeIntents = parseGrantScript(probeScript());
  const workerProbe = PROBE_NAMES[1]?.[1] as string;

  const dropProbes = async (): Promise<void> => {
    for (const [, probe] of PROBE_NAMES) {
      await admin.query(`DROP USER IF EXISTS '${probe}'@'%'`);
    }
  };

  beforeAll(async () => {
    admin = await createConnection({ uri: ADMIN_URL as string, multipleStatements: false });
    await dropProbes();

    // The installation R10 describes, reconstructed: accounts that exist already, each
    // holding what an older revision of this file gave it. The worker's database-wide
    // SELECT is the finding itself; the other two are the cases a reader would reasonably
    // wonder about — a global privilege on the migrator, and a stale write grant on the
    // application for a table the current file no longer names that way.
    for (const [, probe] of PROBE_NAMES) {
      await admin.query(`CREATE USER '${probe}'@'%' IDENTIFIED BY 'pre_existing_password'`);
    }
    await admin.query(`GRANT SELECT ON \`${DATABASE}\`.* TO '${workerProbe}'@'%'`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DATABASE}\`.* TO ` +
        `'${PROBE_NAMES[0]?.[1] as string}'@'%'`,
    );
    await admin.query(`GRANT CREATE USER ON *.* TO '${PROBE_NAMES[2]?.[1] as string}'@'%'`);
    await admin.query('FLUSH PRIVILEGES');
  });

  afterAll(async () => {
    await dropProbes();
    await admin?.end();
  });

  it('the reconstructed installation really does hold the old wide grants', async () => {
    // Without this the reconciliation below could pass against an installation that never
    // had the problem, which is the exact way R10 stayed invisible for as long as it did.
    const before = await heldPrivileges(admin, granteeOf(workerProbe));
    expect(before).toContain(`${DATABASE}.*:SELECT`);
  });

  it('applying the script leaves exactly the stated set and nothing more', async () => {
    // The same function `pnpm db:grants` calls, on the same statements, in file order.
    const report = await applyGrants(admin, probeScript());
    expect(report.statements.length).toBeGreaterThan(0);
    await admin.query('FLUSH PRIVILEGES');

    for (const [real, probe] of PROBE_NAMES) {
      const intent = probeIntents.get(granteeOf(probe));
      expect(intent, `probe script does not define '${probe}'`).toBeDefined();
      const held = await heldPrivileges(admin, granteeOf(probe));
      expect(
        excessOf(intent as PrincipalIntent, held),
        `after re-applying the script, '${real}' still holds more than it states`,
      ).toEqual([]);
      expect(
        missingOf(intent as PrincipalIntent, held),
        `after re-applying the script, '${real}' is missing privileges it states`,
      ).toEqual([]);
    }
  });

  it('the worker’s database-wide SELECT is gone, and the credential tables with it', async () => {
    const held = await heldPrivileges(admin, granteeOf(workerProbe));
    expect(held).not.toContain(`${DATABASE}.*:SELECT`);
    for (const table of [
      'user_passwords',
      'user_mfa_factors',
      'user_recovery_codes',
      'authentication_events',
    ]) {
      expect(held.filter((p) => p.startsWith(`${DATABASE}.${table}`))).toEqual([]);
    }
    // Exactly the named reads the script states, table by table. (A fixed count stood here
    // and went stale as the worker's stores grew: 16 until 2026-10-17, 153 named reads by
    // 2026-11-19; the suite skips without an admin URL, so nothing noticed.)
    const stated = [...(probeIntents.get(granteeOf(workerProbe))?.privileges ?? [])];
    expect(held.filter((p) => p.endsWith(':SELECT')).sort()).toEqual(
      stated.filter((p) => p.endsWith(':SELECT')).sort(),
    );
  });

  it('the server enforces it — the upgraded worker is refused the password table', async () => {
    // Privilege rows are what the script wrote; this is the server acting on them, as the
    // relay's own credential rather than as the administrative one this suite otherwise
    // uses. `ER_TABLEACCESS_DENIED_ERROR` (1142) is the privilege system refusing, not a
    // trigger — the distinction `least-privilege.db.test.ts` draws, for the same reason.
    const url = new URL(ADMIN_URL as string);
    url.username = workerProbe;
    url.password = 'pre_existing_password';
    url.pathname = `/${DATABASE}`;
    const worker: Pool = createPool({
      uri: url.toString(),
      connectionLimit: 1,
      multipleStatements: false,
    });
    try {
      const [who] = await worker.query<RowDataPacket[]>('select current_user() as u');
      expect(String(who[0]?.['u'])).toMatch(new RegExp(`^${workerProbe}@`));

      let refused: { code?: string; errno?: number } | undefined;
      try {
        await worker.query('select * from user_passwords limit 1');
      } catch (error) {
        refused = error as { code?: string; errno?: number };
      }
      expect(refused, 'the upgraded worker could still read user_passwords').toBeDefined();
      expect(refused?.code).toBe('ER_TABLEACCESS_DENIED_ERROR');
      expect(refused?.errno).toBe(1142);

      // And the narrowing is not an outage: the first statement the dispatcher issues.
      const [rows] = await worker.query<RowDataPacket[]>(
        'select id from outbox_events where published_at is null limit 1',
      );
      expect(Array.isArray(rows)).toBe(true);
    } finally {
      await worker.end();
    }
  });

  it('applying the script a second time changes nothing', async () => {
    // Idempotence in the strong sense, measured rather than asserted: the privileges after
    // the second application are byte-for-byte the privileges after the first.
    const before = await Promise.all(
      PROBE_NAMES.map(([, probe]) => heldPrivileges(admin, granteeOf(probe))),
    );
    await applyGrants(admin, probeScript());
    await admin.query('FLUSH PRIVILEGES');
    const after = await Promise.all(
      PROBE_NAMES.map(([, probe]) => heldPrivileges(admin, granteeOf(probe))),
    );
    expect(after).toEqual(before);
  });
});
