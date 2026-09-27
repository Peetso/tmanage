import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitStatements } from './migrator.js';

/**
 * `scripts/db/users.sql` against the schema it grants on — ADR-0001 layer 2, statically.
 *
 * This file exists because of how layer 2 failed. `users.sql` was written, reviewed, and
 * never executed anywhere, and it could not have executed: `compose.yaml` mounted it into
 * `/docker-entrypoint-initdb.d/`, which runs before any migration, while every grant in it
 * is table-level and therefore needs its table to already exist. Nothing in the repository
 * could notice, because nothing compared the two files.
 *
 * The containerised CI job now runs the real thing against a real MySQL server, which is the
 * evidence that matters. These assertions are the cheap check that runs on every commit and
 * fails in a second rather than after a container boot — and, more usefully, the thing that
 * makes a *new* table a decision rather than an omission. A migration that adds a tenant
 * table nobody grants on produces an application that cannot write it; the failure would
 * otherwise appear at runtime, in whichever environment ran the new migration first.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '../../../migrations');
const USERS_SQL = resolve(HERE, '../../../../../scripts/db/users.sql');

const usersSql = readFileSync(USERS_SQL, 'utf8');
const statements = splitStatements(usersSql);

/** Tables the migrations create, in the order they are created. */
const schemaTables: readonly string[] = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .flatMap((file) => [
    ...readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8').matchAll(
      /^CREATE TABLE (?:IF NOT EXISTS )?`?([a-z_]+)`?/gim,
    ),
  ])
  .map((match) => match[1] as string);

interface Grant {
  readonly privileges: readonly string[];
  readonly database: string;
  /** `*` for a database-wide grant. */
  readonly table: string;
  readonly user: string;
}

const grants: readonly Grant[] = statements
  .map((statement) =>
    /^GRANT\s+(.+?)\s+ON\s+`?([a-z_]+)`?\.(?:`([a-z_]+)`|\*)\s+TO\s+'([a-z_]+)'@/i.exec(statement),
  )
  .filter((match): match is RegExpExecArray => match !== null)
  .map((match) => ({
    privileges: (match[1] as string).split(',').map((p) => p.trim().toUpperCase()),
    database: match[2] as string,
    table: (match[3] as string | undefined) ?? '*',
    user: match[4] as string,
  }));

const grantsFor = (user: string) => grants.filter((grant) => grant.user === user);

const privilegesOn = (user: string, table: string): readonly string[] =>
  grantsFor(user)
    .filter((grant) => grant.table === table)
    .flatMap((grant) => grant.privileges);

/** Everything the user can do to `table`, including via a database-wide grant. */
const effectivePrivilegesOn = (user: string, table: string): readonly string[] => [
  ...grantsFor(user)
    .filter((grant) => grant.table === '*')
    .flatMap((grant) => grant.privileges),
  ...privilegesOn(user, table),
];

describe('scripts/db/users.sql — the grants parse and are well formed', () => {
  it('contains only statements the server can execute, and no stray prose', () => {
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement, statement).toMatch(/^(CREATE USER|REVOKE|GRANT|FLUSH PRIVILEGES)\b/i);
    }
  });

  it('creates every user it grants to', () => {
    const created = new Set(
      statements
        .map((statement) => /^CREATE USER IF NOT EXISTS '([a-z_]+)'@/i.exec(statement))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => match[1] as string),
    );
    // MySQL refuses GRANT to an unknown user, so a grant without a matching create is not
    // a style problem — it aborts the script.
    for (const grant of grants) {
      expect(created.has(grant.user), `no CREATE USER for '${grant.user}'`).toBe(true);
    }
  });

  it('revokes everything from each user before it grants anything to it — R10', () => {
    // The defect this assertion exists for, stated as an ordering rule over the file.
    //
    // MySQL privileges are additive, and this script creates its accounts with
    // `CREATE USER IF NOT EXISTS`, so on a server provisioned by an older revision every
    // grant that revision issued survives a re-run. The worker's pre-D07 database-wide
    // SELECT survived exactly that way, which meant the fourteen narrow grants below it
    // narrowed nothing on any existing installation — the only installations that matter.
    // A `REVOKE ALL PRIVILEGES, GRANT OPTION` per principal, after its create and before
    // its first grant, is what makes re-applying this file *reduce* privilege rather than
    // only ever add it.
    //
    // Positional, not merely present: a revoke that ran after the grants would leave the
    // principal with nothing at all, which is an outage rather than a leak but is no more
    // correct.
    const seenCreate = new Map<string, number>();
    const seenRevoke = new Map<string, number>();
    const firstGrant = new Map<string, number>();

    statements.forEach((statement, index) => {
      const created = /^CREATE USER IF NOT EXISTS '([a-z_]+)'@/i.exec(statement);
      if (created) seenCreate.set(created[1] as string, index);

      const revoked = /^REVOKE\s+ALL\s+PRIVILEGES\s*,\s*GRANT\s+OPTION\s+FROM\s+'([a-z_]+)'@/i.exec(
        statement.replace(/\s+/g, ' '),
      );
      if (revoked) seenRevoke.set(revoked[1] as string, index);

      const granted = /^GRANT\s+.+?\s+TO\s+'([a-z_]+)'@/is.exec(statement);
      if (granted && !firstGrant.has(granted[1] as string)) {
        firstGrant.set(granted[1] as string, index);
      }
    });

    for (const [user, createdAt] of seenCreate) {
      const revokedAt = seenRevoke.get(user);
      expect(revokedAt, `no REVOKE ALL PRIVILEGES for '${user}'`).toBeDefined();
      expect(
        (revokedAt as number) > createdAt,
        `'${user}' is revoked before it is created — MySQL refuses a REVOKE for an ` +
          'unknown user',
      ).toBe(true);
      const grantedAt = firstGrant.get(user);
      if (grantedAt !== undefined) {
        expect(
          (revokedAt as number) < grantedAt,
          `'${user}' is revoked after it is granted, which leaves it with no privileges`,
        ).toBe(true);
      }
    }
  });

  it('names one database only, so no grant can reach a neighbouring environment', () => {
    // 50-BOOTSTRAP §4 puts every environment on one server.
    expect([...new Set(grants.map((grant) => grant.database))]).toEqual(['tmanage']);
  });
});

describe('the grants and the schema agree', () => {
  it('grants only on tables the migrations actually create', () => {
    // The bug this file was written for: a table-level GRANT naming a table that does not
    // exist aborts with ER_NO_SUCH_TABLE, taking every later grant with it.
    const known = new Set([...schemaTables, 'schema_migrations']);
    for (const grant of grants) {
      if (grant.table === '*') continue;
      expect(known.has(grant.table), `users.sql grants on unknown table '${grant.table}'`).toBe(
        true,
      );
    }
  });

  it('decides explicitly about every table in the schema', () => {
    // A new migration must not be able to add a table that the runtime user silently cannot
    // write. Either grant on it, or add it to the deliberately-withheld list below with a
    // reason — but not neither.
    const withheldOnPurpose: Record<string, string> = {
      audit_events: 'append-only: INSERT granted, UPDATE and DELETE withheld',
      message_revisions:
        'engine-authored: the 0008 trigger writes it with definer privileges — ' +
        'a runtime credential that could INSERT could forge history',
      schema_migrations: 'the migrator alone writes the ledger',
      changelog_entries:
        'x160 read-only from the application: the public changelog route only SELECTs (via the ' +
        'database-wide read grant); no app write path exists this slice — entries are authored by ' +
        'a later admin slice, which adds the INSERT/UPDATE grant with the code that writes it',
    };
    for (const table of schemaTables) {
      const writable = privilegesOn('tmanage_app', table);
      expect(
        writable.length > 0 || table in withheldOnPurpose,
        `neither granted nor deliberately withheld from tmanage_app: '${table}'`,
      ).toBe(true);
    }
  });
});

describe('the runtime user is actually least-privilege', () => {
  it('never receives a schema or server privilege', () => {
    // These are what separate "can write rows" from "owns the database". Layer 2 is only
    // worth having if none of them is ever granted.
    const forbidden = [
      'ALL PRIVILEGES',
      'ALTER',
      'CREATE',
      'CREATE USER',
      'CREATE VIEW',
      'DROP',
      'FILE',
      'GRANT OPTION',
      'INDEX',
      'PROCESS',
      'REFERENCES',
      'RELOAD',
      'SUPER',
      'TRIGGER',
    ];
    for (const user of ['tmanage_app', 'tmanage_worker']) {
      const held = new Set(grantsFor(user).flatMap((grant) => grant.privileges));
      for (const privilege of forbidden) {
        expect(held.has(privilege), `'${user}' must not hold ${privilege}`).toBe(false);
      }
    }
  });

  it('never grants a write privilege database-wide', () => {
    // The asymmetry the file depends on. MySQL privileges are additive and cannot be
    // revoked for one table after a database-wide grant, so withholding UPDATE on
    // audit_events is only possible if UPDATE is never granted on `tmanage`.* at all.
    for (const grant of grants.filter((g) => g.table === '*' && g.user !== 'tmanage_migrator')) {
      expect(grant.privileges, `'${grant.user}' holds a database-wide write`).toEqual(['SELECT']);
    }
  });

  it('can append to the audit log and can never amend it', () => {
    const effective = effectivePrivilegesOn('tmanage_app', 'audit_events');
    expect(effective).toContain('INSERT');
    expect(effective).toContain('SELECT');
    expect(effective).not.toContain('UPDATE');
    expect(effective).not.toContain('DELETE');
  });

  it('cannot forge a migration ledger row', () => {
    const effective = effectivePrivilegesOn('tmanage_app', 'schema_migrations');
    expect(effective).toEqual(['SELECT']);
  });

  it('withholds DELETE from the worker everywhere', () => {
    // A defective consumer must not be able to destroy work.
    for (const grant of grantsFor('tmanage_worker')) {
      expect(grant.privileges, `worker grant on ${grant.table}`).not.toContain('DELETE');
    }
  });

  it('never receives a database-wide SELECT for the worker', () => {
    // D07. The database-wide read above is a convenience the application earns: a new
    // module's tables are readable the moment a migration creates them, and nobody has to
    // remember to amend `users.sql` before the first request. The relay earns nothing by
    // it — it reads a fixed, short list of tables, named one by one in the file — and the
    // convenience was paying for read access to every password hash and MFA seed on the
    // server. A table-level grant per real dependency is the whole of the fix, so this is
    // the assertion that stops `SELECT ON \`tmanage\`.*` coming back for the old reason.
    for (const grant of grantsFor('tmanage_worker')) {
      expect(grant.table, `'tmanage_worker' holds a database-wide grant`).not.toBe('*');
    }
  });

  it('never grants the worker anything on the credential tables', () => {
    // The point D07 was raised for. A relay is a batch process on the same host as the
    // API, restarted by cron, and its connection string is read by whoever operates it;
    // what it must never be is a second way to read the second factor. Nothing in
    // `apps/worker/src` names any of these four tables, and nothing should: an MFA seed is
    // decrypted inside the API's identity module and nowhere else.
    //
    // Asserted on the *effective* privileges — a reintroduced `SELECT ON \`tmanage\`.*`
    // fails here as well as above, which is what makes this case independent of that one.
    const credentialTables = [
      'user_passwords',
      'user_mfa_factors',
      'user_recovery_codes',
      'authentication_events',
    ];
    for (const table of credentialTables) {
      expect(
        effectivePrivilegesOn('tmanage_worker', table),
        `'tmanage_worker' can reach '${table}'`,
      ).toEqual([]);
    }
  });

  it('can read every table the worker is allowed to write', () => {
    // The failure mode the narrowing above introduces, and the reason the worker's SELECT
    // list is not simply the tables its SELECTs name. MySQL reads to write: an
    // `UPDATE … WHERE` needs SELECT on the columns it filters by, and the notification
    // insert's `ON DUPLICATE KEY UPDATE id = id` reads the row it collided with. A write
    // grant without the matching read is a grant that cannot be used, and the statement
    // that discovers it fails in the relay rather than here.
    const appendOnlyForTheWorker: Record<string, string> = {
      audit_events:
        'the relay appends a system audit row and never reads one back, so SELECT ' +
        'would be privilege granted against no statement',
    };
    const written = new Set(
      grantsFor('tmanage_worker')
        .filter((grant) => grant.table !== '*')
        .filter((grant) => grant.privileges.some((privilege) => privilege !== 'SELECT'))
        .map((grant) => grant.table),
    );
    for (const table of written) {
      if (table in appendOnlyForTheWorker) continue;
      expect(
        effectivePrivilegesOn('tmanage_worker', table),
        `'tmanage_worker' may write '${table}' but not read it`,
      ).toContain('SELECT');
    }
  });
});

describe('the file states its own ordering requirement', () => {
  it('says it must run after the migrations', () => {
    // The comment is the only thing an operator applying this by hand will read, and the
    // original failure was precisely an ordering mistake.
    expect(usersSql).toMatch(/after\s+`?pnpm db:migrate`?/i);
  });

  it('is not mounted into a container init directory anywhere in the repository', () => {
    // docker-entrypoint-initdb.d runs on first boot, necessarily before any migration.
    // That mount is how this file came to be unrunnable; this assertion is what stops it
    // being reintroduced by someone who reasonably assumes it belongs there.
    const compose = readFileSync(resolve(HERE, '../../../../../compose.yaml'), 'utf8');
    const mounts = compose
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => line.includes('docker-entrypoint-initdb.d'));
    expect(mounts).toEqual([]);
  });
});
