import { drizzle } from 'drizzle-orm/mysql-proxy';
import type { MySqlRemoteDatabase } from 'drizzle-orm/mysql-proxy';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import * as schema from './schema.js';
import type { SqlParameter, TenantQueryRunner } from './tenant-context.js';

/**
 * Drizzle, wired so that it cannot reach the connection pool.
 *
 * This is the single most important structural decision in the access layer, so it is worth
 * stating plainly. `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 mandates Drizzle. The
 * obvious way to satisfy that — `drizzle(pool, { schema })` — would hand the ORM a driver
 * handle and let it execute whatever it builds. Every statement issued that way bypasses
 * `assertTenantScoped`, and **ADR-0001 layer 3 would be silently dead**: still present in
 * the codebase, still passing its own unit tests, and no longer on the path of a single
 * production query. That is a worse failure than not having the guard at all, because the
 * tests and the documentation would both continue to say it was there.
 *
 * So Drizzle is given a `RemoteCallback` instead of a driver. It builds SQL and parameters;
 * the callback hands them to a {@link TenantQueryRunner}, which runs the guard first and
 * only then reaches the connection the transaction is bound to. Drizzle never holds a pool,
 * a connection, or a credential — it is a query *builder* here, and the execution path is
 * unchanged from the raw-SQL one the isolation corpus already exercises.
 *
 * The practical consequences are worth knowing:
 *
 * - A repository that forgets `eq(projects.organizationId, ctx.organizationId)` throws, in
 *   development and in production, exactly as a hand-written statement would.
 * - `db.transaction()` from Drizzle is **not** available through the proxy driver, which is
 *   correct: transactions are owned by `TenantDatabase.transaction()`, which binds one
 *   connection to one `TenantContext` for the whole unit of work. Two transaction
 *   mechanisms over one connection would be a way to open a second, unbound one.
 * - Drizzle's relational query API (`db.query.*`) needs a schema-aware session and is not
 *   wired here. Joins are written explicitly, which §5 wants anyway — "every lookup,
 *   update, delete, join ... begins with or includes `organization_id`" is easier to review
 *   in an explicit join than in a generated one.
 */

/** What Drizzle's proxy callback is allowed to send us. Widened only where mysql2 needs it. */
type ProxyParameter = SqlParameter | readonly SqlParameter[];

export type TenantDrizzle = MySqlRemoteDatabase<typeof schema>;

/**
 * `method` is `'all'` for statements Drizzle expects rows back from and `'execute'` for
 * everything else. mysql2 returns `RowDataPacket[]` for the former and a `ResultSetHeader`
 * for the latter, and the two are distinguished by shape rather than by type.
 */
function isResultSetHeader(result: unknown): result is ResultSetHeader {
  return (
    typeof result === 'object' &&
    result !== null &&
    'affectedRows' in result &&
    !Array.isArray(result)
  );
}

/**
 * Present a driver value the way Drizzle's proxy dialect expects to receive it.
 *
 * The proxy driver's contract is "whatever a driver speaking MySQL's **text** protocol
 * would hand back", and Drizzle's column decoders are written against that. A `datetime`
 * column decodes with `value.replace(' ', 'T') + 'Z'`, so it requires a string; mysql2 is
 * configured with `dateStrings: false` and returns a `Date`, which fails with
 * `value.replace is not a function`.
 *
 * Converting here rather than setting `dateStrings: true` on the pool is deliberate. That
 * flag is global to the connection, and the isolation corpus, the migrator and the seed
 * fixtures all read `DATETIME(3)` columns as `Date` objects through the same pool. Changing
 * it to satisfy Drizzle would silently change the type of every temporal value in code that
 * has nothing to do with Drizzle.
 *
 * The conversion is lossless for this schema: the session time zone is UTC, every temporal
 * column is `DATETIME(3)`, and `toISOString()` preserves exactly three fractional digits —
 * so Drizzle's decoder reconstructs the identical instant.
 */
function toDriverText(value: unknown): unknown {
  return value instanceof Date ? value.toISOString().replace('T', ' ').replace('Z', '') : value;
}

/**
 * Build a Drizzle handle over one guarded runner.
 *
 * Called per unit of work, inside `TenantDatabase.transaction()`, `.read()` or
 * `.bootstrapRead()` — not once at startup. A module-level Drizzle instance would have to
 * hold a pool to be useful, which is the thing this file exists to prevent.
 *
 * The parameter asks for `query` alone rather than for a whole `TenantQueryRunner`, so the
 * bootstrap runner — which offers nothing else, deliberately — can be handed here too. It is
 * a narrowing of what this function demands, not a widening of what it is given: whichever
 * runner arrives still runs the guard before it reaches a connection.
 */
export function tenantDrizzle(runner: Pick<TenantQueryRunner, 'query'>): TenantDrizzle {
  return drizzle(async (sql, params, method) => {
    // Drizzle hands back `any[]`; narrowing here rather than at the call sites keeps the
    // one unavoidable boundary cast in a single reviewed place.
    const values = params as ProxyParameter[] as SqlParameter[];

    // `query` rather than `execute`: Drizzle emits `limit ?` and `offset ?` as bound
    // parameters, and MySQL's prepared-statement protocol rejects placeholders in those
    // positions on some versions. The guard is applied identically either way — it inspects
    // the statement text and the bound values, not the protocol used to send them.
    //
    // `rowsAsArray` is not an optimization. Drizzle maps result columns **positionally**,
    // and mysql2's default object rows are keyed by unqualified column name — so a join
    // selecting `organizations.id` and `memberships.id` returns one `id` key, not two. The
    // duplicate is silently dropped, every later value shifts a position to the left, and
    // the first symptom is a decoder failing on a value from the wrong column. Asking the
    // driver for positional rows removes the ambiguity at its source rather than requiring
    // every future join to remember to alias.
    const result = await runner.query<RowDataPacket[] | ResultSetHeader>(sql, values, {
      rowsAsArray: true,
    });

    if (isResultSetHeader(result)) {
      // Counter-intuitive but exact: for a non-select the proxy dialect reads
      // `rows[0].insertId` and `rows[0].affectedRows`, so the header goes *inside* `rows`.
      // The top-level `insertId`/`affectedRows` fields on the callback's return type are
      // not the ones it consults, and populating only those produces
      // `Cannot read properties of undefined (reading 'insertId')`.
      return { rows: [result] };
    }

    // Already positional, thanks to `rowsAsArray`; only the value conversion is left.
    return {
      rows:
        method === 'all'
          ? (result as unknown as unknown[][]).map((row) => row.map(toDriverText))
          : result,
    };
  }, {});
}

export { schema };
