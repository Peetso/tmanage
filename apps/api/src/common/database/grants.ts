import { splitStatements } from './migrator.js';

/**
 * Applying `scripts/db/users.sql`, and reading back what it says each principal may hold.
 *
 * Extracted from `cli.ts` for one reason: the verification that the grants actually in force
 * on a server match the file must exercise **the code `pnpm db:grants` runs**, not a second
 * implementation that happens to look similar. `apps/api/test/grant-reconciliation.db.test.ts`
 * imports `applyGrants` from here, and `cli.ts` calls the same function.
 *
 * ## Why a REVOKE may fail, and when that is not a failure
 *
 * `users.sql` revokes every privilege from each account before rebuilding it (R10). On an
 * account that holds nothing yet — the fresh-database case, which must stay supported —
 * servers disagree about what to say. MySQL 8 accepts the statement silently. MariaDB
 * answers `ER_REVOKE_GRANTS` (1269, "Can't revoke all privileges for one or more of the
 * requested users"), and `ER_NONEXISTING_GRANT` (1141) is the other shape the same
 * nothing-to-do can take. Both mean the account ended the statement holding no privileges,
 * which is exactly what the `REVOKE` was for.
 *
 * Tolerating them is safe here and nowhere else, because of where the statement sits: every
 * `REVOKE` in `users.sql` names the account created by the `CREATE USER IF NOT EXISTS`
 * immediately above it, and a failed create aborts the run before the revoke is reached. So
 * neither error can mean "unknown user" in this file. The tolerance is deliberately narrow —
 * two errno values, `REVOKE` statements only — and everything else, including an access
 * denial on a revoke, still fails the command.
 */

/** ER_NONEXISTING_GRANT — there was no such grant to take away. */
export const ER_NONEXISTING_GRANT = 1141;
/** ER_REVOKE_GRANTS — "can't revoke all privileges"; MariaDB's answer for an empty account. */
export const ER_REVOKE_GRANTS = 1269;

/** The subset of a mysql2 connection this module needs, so a test can supply a fake. */
export interface GrantConnection {
  query(sql: string): Promise<unknown>;
}

export interface AppliedStatement {
  /** 1-based, matching the operator-facing error message. */
  readonly index: number;
  readonly statement: string;
  /** `executed`, or `no-op` for a REVOKE the server had nothing to do for. */
  readonly outcome: 'executed' | 'no-op';
}

export interface GrantReport {
  readonly statements: readonly AppliedStatement[];
  /** How many REVOKEs found nothing to remove — every one, on a fresh database. */
  readonly noOpRevokes: number;
}

export class GrantApplicationError extends Error {
  constructor(
    message: string,
    readonly index: number,
    readonly total: number,
    readonly statement: string,
    /** The driver error, kept under its own name: `Error.cause` is declared by the base. */
    readonly driverError: unknown,
  ) {
    super(message);
    this.name = 'GrantApplicationError';
  }
}

function errnoOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const errno = (error as { errno?: unknown }).errno;
  return typeof errno === 'number' ? errno : undefined;
}

const isRevoke = (statement: string): boolean => /^REVOKE\b/i.test(statement.trimStart());

/**
 * Apply a grant script statement by statement, in file order.
 *
 * Order is load-bearing three times over and is never rearranged: the table-level grants
 * need `db:migrate` to have run (a GRANT naming an absent table is `ER_NO_SUCH_TABLE`), each
 * `REVOKE` needs the `CREATE USER` above it, and each principal's grants need the `REVOKE`
 * above *them* or the rebuild is a union with whatever was already there.
 */
export async function applyGrants(connection: GrantConnection, sql: string): Promise<GrantReport> {
  const statements = splitStatements(sql);
  const applied: AppliedStatement[] = [];

  for (const [offset, statement] of statements.entries()) {
    const index = offset + 1;
    try {
      await connection.query(statement);
      applied.push({ index, statement, outcome: 'executed' });
    } catch (error) {
      const errno = errnoOf(error);
      if (isRevoke(statement) && (errno === ER_NONEXISTING_GRANT || errno === ER_REVOKE_GRANTS)) {
        applied.push({ index, statement, outcome: 'no-op' });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new GrantApplicationError(message, index, statements.length, statement, error);
    }
  }

  return {
    statements: applied,
    noOpRevokes: applied.filter((entry) => entry.outcome === 'no-op').length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the file's intent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One privilege at one scope, spelled the way `information_schema` spells it so the two can
 * be compared directly: `` `tmanage`.* `` becomes `tmanage.*:SELECT`, a table grant becomes
 * `tmanage.outbox_events:UPDATE`, and a global grant becomes `*.*:FILE`.
 */
export type PrivilegeKey = string;

/** The sentinel a `GRANT ALL PRIVILEGES ON db.*` produces; see `allows` below. */
export const ALL_PRIVILEGES = 'ALL PRIVILEGES';

export interface PrincipalIntent {
  /** `'tmanage_worker'@'%'`, matching `information_schema`'s GRANTEE spelling. */
  readonly grantee: string;
  readonly user: string;
  readonly host: string;
  /** Every privilege the script grants, at the scope it grants it. */
  readonly privileges: ReadonlySet<PrivilegeKey>;
  /** True when the script revokes everything from this principal before granting. */
  readonly revokedFirst: boolean;
}

/**
 * The characters an identifier may contain, here.
 *
 * Deliberately not `[a-z_]`. A MySQL account name legitimately carries digits — and the
 * verification in `apps/api/test/grant-reconciliation.db.test.ts` relies on that, because it
 * applies this script to *renamed probe accounts* whose suffix is the process id, so that
 * revoking and rebuilding does not disarm a live `tmanage_app`. With a letters-only class
 * those names matched nothing, and since this parser **throws** on a statement it does not
 * recognise (that strictness is deliberate; see `parseGrantScript`), the mismatch was not a
 * skipped statement but an exception at suite-collection time — which Vitest raises even for
 * a `describe.skipIf` that is skipped, because the factory is still evaluated. The whole
 * upgrade proof was therefore unreachable, and `pnpm test:db` could redden on it.
 *
 * The class is widened rather than the probe names narrowed because the narrow one was simply
 * wrong about MySQL: `$`, `.` and `-` are also ordinary in account names, and this function's
 * answer is the *expected* side of a security assertion — it must not fail to describe a
 * principal that really exists.
 */
/** A schema or table name. No `.`: the dot between the two scopes has to stay a separator. */
const OBJECT_IDENT = String.raw`[A-Za-z0-9_$]+`;
/** An account name, always quoted here, so `.` and `-` are unambiguous inside it. */
const ACCOUNT_IDENT = String.raw`[A-Za-z0-9_$.-]+`;

const GRANT_RE = new RegExp(
  String.raw`^GRANT\s+(.+?)\s+ON\s+(?:\`?(${OBJECT_IDENT})\`?|\*)\.(?:\`?(${OBJECT_IDENT})\`?|\*)` +
    String.raw`\s+TO\s+'(${ACCOUNT_IDENT})'@'([^']+)'`,
  'i',
);
const REVOKE_RE = new RegExp(
  String.raw`^REVOKE\s+ALL\s+PRIVILEGES\s*,\s*GRANT\s+OPTION\s+FROM\s+'(${ACCOUNT_IDENT})'@'([^']+)'`,
  'i',
);
const CREATE_RE = new RegExp(
  String.raw`^CREATE USER(?: IF NOT EXISTS)?\s+'(${ACCOUNT_IDENT})'@'([^']+)'`,
  'i',
);

/**
 * What `scripts/db/users.sql` says each principal should end up holding.
 *
 * The parse is deliberately strict — an unrecognised `GRANT` is not silently dropped, it
 * throws — because this function's answer is used as the *expected* side of a security
 * assertion. A parser that quietly ignored a statement it did not understand would turn a
 * privilege nobody checked into a test that passes.
 */
export function parseGrantScript(sql: string): Map<string, PrincipalIntent> {
  const byGrantee = new Map<
    string,
    { user: string; host: string; privileges: Set<string>; revokedFirst: boolean }
  >();

  const ensure = (user: string, host: string) => {
    const grantee = `'${user}'@'${host}'`;
    let entry = byGrantee.get(grantee);
    if (!entry) {
      entry = { user, host, privileges: new Set<string>(), revokedFirst: false };
      byGrantee.set(grantee, entry);
    }
    return entry;
  };

  for (const statement of splitStatements(sql)) {
    const flat = statement.replace(/\s+/g, ' ').trim();

    if (/^FLUSH PRIVILEGES\b/i.test(flat)) continue;

    const created = CREATE_RE.exec(flat);
    if (created) {
      ensure(created[1] as string, created[2] as string);
      continue;
    }

    const revoked = REVOKE_RE.exec(flat);
    if (revoked) {
      ensure(revoked[1] as string, revoked[2] as string).revokedFirst = true;
      continue;
    }

    const granted = GRANT_RE.exec(flat);
    if (granted) {
      const database = (granted[2] as string | undefined) ?? '*';
      const table = (granted[3] as string | undefined) ?? '*';
      const entry = ensure(granted[4] as string, granted[5] as string);
      for (const privilege of (granted[1] as string).split(',')) {
        entry.privileges.add(`${database}.${table}:${privilege.trim().toUpperCase()}`);
      }
      continue;
    }

    throw new Error(
      `parseGrantScript does not understand this statement, so it cannot be trusted to ` +
        `describe what the script grants:\n  ${flat}`,
    );
  }

  return new Map(
    [...byGrantee].map(([grantee, entry]) => [
      grantee,
      {
        grantee,
        user: entry.user,
        host: entry.host,
        privileges: entry.privileges,
        revokedFirst: entry.revokedFirst,
      },
    ]),
  );
}

/**
 * Does this principal's stated set permit `held`?
 *
 * Exact match, with one expansion: `ALL PRIVILEGES ON db.*` is a single token in the script
 * and roughly thirty individual rows in `information_schema`, so a stated
 * `db.*:ALL PRIVILEGES` permits any privilege at that same `db.*` scope — and, pointedly,
 * nothing at `*.*` and nothing on another schema. That is the whole of the migrator's
 * intended set: it may own one database and may hold no global privilege.
 */
export function allows(intent: PrincipalIntent, held: PrivilegeKey): boolean {
  if (intent.privileges.has(held)) return true;
  const scope = held.slice(0, held.lastIndexOf(':'));
  return intent.privileges.has(`${scope}:${ALL_PRIVILEGES}`);
}

/** Privileges held that the script does not state — the failure R10 is about. */
export function excessOf(intent: PrincipalIntent, held: Iterable<PrivilegeKey>): PrivilegeKey[] {
  return [...held].filter((privilege) => !allows(intent, privilege)).sort();
}

/** Privileges the script states that are not actually held — a broken install, not a leak. */
export function missingOf(intent: PrincipalIntent, held: Iterable<PrivilegeKey>): PrivilegeKey[] {
  const actual = new Set(held);
  return [...intent.privileges]
    .filter((privilege) => !privilege.endsWith(`:${ALL_PRIVILEGES}`))
    .filter((privilege) => !actual.has(privilege))
    .sort();
}
