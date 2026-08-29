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
 * The containerised CI job now runs the real thing against a real MariaDB, which is the
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
      expect(statement, statement).toMatch(/^(CREATE USER|GRANT|FLUSH PRIVILEGES)\b/i);
    }
  });

  it('creates every user it grants to', () => {
    const created = new Set(
      statements
        .map((statement) => /^CREATE USER IF NOT EXISTS '([a-z_]+)'@/i.exec(statement))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => match[1] as string),
    );
    // MySQL 8 and MariaDB 10.4+ both refuse GRANT to an unknown user, so a grant without a
    // matching create is not a style problem — it aborts the script.
    for (const grant of grants) {
      expect(created.has(grant.user), `no CREATE USER for '${grant.user}'`).toBe(true);
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
