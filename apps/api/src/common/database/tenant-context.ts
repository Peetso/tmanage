import { isUuid } from '@tmanage/domain';
import type { Capability, PrincipalKind } from '@tmanage/domain';
import type {
  Pool,
  PoolConnection,
  QueryOptions,
  QueryResult,
  RowDataPacket,
} from 'mysql2/promise';
import {
  assertTenantScoped,
  isNonTenantTable,
  isTenantTable,
  tenantTablesMentioned,
} from './tenant-guard.js';
import type { TenantGuardEvent, TenantGuardMode } from './tenant-guard.js';
import { unwrapQueryError } from './query-error.js';

/**
 * Trusted tenant context and the organization-bound transaction wrapper — AUTHZ-001.
 *
 * Spec section 2: "The API creates an immutable `TenantContext` containing
 * `organizationId`, `userId`, `principalKind`, `membershipId`, capabilities, policy
 * version, and correlation ID."
 *
 * Two properties of this file carry the weight:
 *
 * 1. **The context is immutable and can only be built from verified facts.** A context is
 *    produced *after* the API has confirmed an active membership; it is never assembled
 *    from a header, a request body, a query string, or a job payload (section 2). Freezing
 *    it means a downstream service cannot rewrite `organizationId` half way through a
 *    request and have the change follow the transaction.
 *
 * 2. **The transaction wrapper is the only supported route to the database.** It binds a
 *    single pooled connection to one context for the whole unit of work and routes every
 *    statement through the tenant guard first. Section 6 requires an organization-bound
 *    transaction wrapper for multi-write commands; making it the *only* entry point is
 *    what stops a command from doing three scoped writes and one unscoped one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TenantContext
// ─────────────────────────────────────────────────────────────────────────────

export interface TenantContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly principalKind: PrincipalKind;
  /** The membership row that authorised this context. Internal or client. */
  readonly membershipId: string;
  /** Resolved once per request; repositories never re-derive them mid-transaction. */
  readonly capabilities: readonly Capability[];
  /** Cache keys and authorization decisions are invalidated when this changes (section 9). */
  readonly policyVersion: string;
  readonly correlationId: string;
}

export type TenantContextInput = {
  readonly [K in keyof TenantContext]: TenantContext[K];
};

export class InvalidTenantContextError extends Error {
  constructor(message: string) {
    super(`Invalid TenantContext: ${message}`);
    this.name = 'InvalidTenantContextError';
  }
}

/**
 * Build a frozen context, rejecting anything structurally impossible.
 *
 * The identifier checks are shape checks, not authorization: a well-formed UUID proves
 * nothing about membership. Authorization happened before this call — see section 3 steps
 * 1 to 3. What these checks buy is that a malformed value cannot reach a SQL parameter and
 * be silently coerced by the driver into something that matches a different row.
 */
export function createTenantContext(input: TenantContextInput): TenantContext {
  const requireUuid = (label: string, value: string): string => {
    if (!isUuid(value)) throw new InvalidTenantContextError(`${label} is not a UUID`);
    const canonical = value.toLowerCase();
    if (canonical !== value) {
      // The schema stores canonical lowercase CHAR(36) (tmanage-core.dbml header). An
      // upper-case id would compare unequal under a case-sensitive collation and equal
      // under a case-insensitive one — an inconsistency worth refusing outright.
      throw new InvalidTenantContextError(`${label} must be canonical lowercase`);
    }
    return canonical;
  };

  // `service` is legitimate — background jobs and named cross-tenant entry points run as
  // one (section 10) — but a service context is still bound to exactly one organization.
  // A job that needs several resolves each of them separately, through its own context.
  const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['internal', 'client', 'service'];
  if (!PRINCIPAL_KINDS.includes(input.principalKind)) {
    throw new InvalidTenantContextError(
      `principalKind '${String(input.principalKind)}' is unknown`,
    );
  }
  if (input.policyVersion.trim().length === 0) {
    throw new InvalidTenantContextError('policyVersion must not be empty');
  }

  return Object.freeze({
    organizationId: requireUuid('organizationId', input.organizationId),
    userId: requireUuid('userId', input.userId),
    principalKind: input.principalKind,
    membershipId: requireUuid('membershipId', input.membershipId),
    capabilities: Object.freeze([...input.capabilities]),
    policyVersion: input.policyVersion,
    correlationId: requireUuid('correlationId', input.correlationId),
  });
}

/**
 * The user id and membership id a `service` context carries.
 *
 * The nil UUID — the same value {@link UNRESOLVED_ORGANIZATION_ID} uses, for the same
 * reason: `uuidv7()` cannot produce it, so it can never name a real person or a real
 * membership row. A background job (spec section 10) has neither. It has an organization,
 * because a service context is still bound to exactly one, and it has a correlation id, so
 * the guard events, outbox rows and audit rows of one pass can be read together.
 *
 * Every audit row such a context writes must say `actorUserId: null` explicitly: the
 * repository defaults the actor to `context.userId`, `audit_events.actor_user_id` is a
 * foreign key to `users`, and this value is not a user. USAGE-001 decision 1 (the sweeper's
 * identity) — a different answer from Peter is one edit here.
 */
export const SERVICE_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000000';

export interface ServiceContextInput {
  readonly organizationId: string;
  readonly correlationId: string;
  /**
   * Names the job, the way `'provisioning'` and `'invitation-acceptance'` name theirs — a
   * literal no resolved context can produce, so a cache key or an authorization decision
   * made under it can never be mistaken for a person's.
   */
  readonly policyVersion: string;
}

/**
 * A context for a background job, bound to one organization and to nobody.
 *
 * No capabilities: a job reaches repositories directly (section 10, "background jobs run
 * with scoped repositories") and never `authorize()`, so an empty list is the honest one —
 * a capability here would be a claim nobody checked.
 */
export function createServiceContext(input: ServiceContextInput): TenantContext {
  return createTenantContext({
    organizationId: input.organizationId,
    userId: SERVICE_PRINCIPAL_ID,
    principalKind: 'service',
    membershipId: SERVICE_PRINCIPAL_ID,
    capabilities: [],
    policyVersion: input.policyVersion,
    correlationId: input.correlationId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Guarded query runner
// ─────────────────────────────────────────────────────────────────────────────

export type QueryRows = RowDataPacket[];

/**
 * What may be bound to a placeholder.
 *
 * Narrower than mysql2's own parameter type on purpose. `undefined` is excluded because a
 * dropped object property would otherwise arrive as an unbound placeholder, and arbitrary
 * objects are excluded because a value the driver has to guess at is a value nobody
 * reviewed.
 */
export type SqlParameter = string | number | bigint | boolean | Date | Buffer | null;

/**
 * Driver-level shape options for one statement.
 *
 * The only member is deliberately narrow. `rowsAsArray` asks mysql2 for positional rows
 * instead of objects, which matters for exactly one caller: the Drizzle seam maps result
 * columns positionally, and an object row **silently loses a column** when two selected
 * columns share a name — `organizations.id` and `memberships.id` in one join collapse to a
 * single `id` key. Nothing about that failure is visible at the type level, and the values
 * that survive shift left into the wrong fields.
 */
export interface StatementShapeOptions {
  readonly rowsAsArray?: boolean;
}

export interface TenantQueryRunner {
  /** Parameterized DML/queries via server-side prepared statements. Guarded. */
  execute<T extends QueryResult = QueryRows>(
    sql: string,
    params?: readonly SqlParameter[],
    options?: StatementShapeOptions,
  ): Promise<T>;
  /** For statements prepared statements cannot carry. Guarded identically. */
  query<T extends QueryResult = QueryRows>(
    sql: string,
    params?: readonly SqlParameter[],
    options?: StatementShapeOptions,
  ): Promise<T>;
  /**
   * A reviewed cross-tenant statement. The reason is mandatory, is emitted as a security
   * event, and should name the ticket or the invariant that makes the escape correct.
   *
   * The outbox relay is the canonical legitimate caller: it claims the oldest unpublished
   * events across every organization, so no `organization_id` predicate exists to write.
   */
  unscoped(reason: string): Pick<TenantQueryRunner, 'execute' | 'query'>;
}

export interface TenantDatabaseOptions {
  /**
   * `enforce` throws on a missing tenant predicate; `observe` records and continues.
   * Sourced from `TENANT_GUARD_MODE`, which defaults to `enforce` in every environment
   * including production — see ADR-0001 layer 3 for why production does not default to
   * observe.
   */
  readonly guardMode: TenantGuardMode;
  /** Security-event sink: metric increment, structured log, alert. Never receives values. */
  readonly onGuardEvent?: (event: TenantGuardEvent) => void;
}

/**
 * mysql2 accepts either a SQL string or an options object, and this always builds the
 * object.
 *
 * Returning `string | QueryOptions` instead would be closer to the old call shape and would
 * not compile: `execute` and `query` are overload sets, and a union argument matches neither
 * overload. One shape, one overload, no cast.
 */
function statementOptions(sql: string, shape: StatementShapeOptions | undefined): QueryOptions {
  return { sql, rowsAsArray: shape?.rowsAsArray ?? false };
}

function makeRunner(
  connection: PoolConnection,
  context: TenantContext,
  options: TenantDatabaseOptions,
): TenantQueryRunner {
  const guardOptions = (reason?: string) => ({
    mode: options.guardMode,
    ...(options.onGuardEvent ? { onEvent: options.onGuardEvent } : {}),
    ...(reason ? { allowUnscoped: { reason } } : {}),
  });

  const run = async <T extends QueryResult>(
    method: 'execute' | 'query',
    sql: string,
    params: readonly SqlParameter[],
    shape: StatementShapeOptions | undefined,
    reason?: string,
  ): Promise<T> => {
    assertTenantScoped(
      sql,
      params,
      { organizationId: context.organizationId, correlationId: context.correlationId },
      guardOptions(reason),
    );
    // Branched rather than indexed: mysql2 types `execute` and `query` as separate
    // overload sets, and the union of them is not callable.
    const values = params as SqlParameter[];
    const [result] =
      method === 'execute'
        ? await connection.execute<T>(statementOptions(sql, shape), values)
        : await connection.query<T>(statementOptions(sql, shape), values);
    return result;
  };

  return {
    execute: (sql, params = [], shape) => run('execute', sql, params, shape),
    query: (sql, params = [], shape) => run('query', sql, params, shape),
    unscoped: (reason: string) => ({
      execute: (sql, params = [], shape) => run('execute', sql, params, shape, reason),
      query: (sql, params = [], shape) => run('query', sql, params, shape, reason),
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The bootstrap read — the one query that cannot be tenant-scoped
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The organization id carried by a guard event raised before any tenant exists.
 *
 * The nil UUID, which `uuidv7()` cannot produce — its version nibble is always `7` — so
 * this can never collide with a real organization. It appears in the security event for a
 * bootstrap read and says exactly what is true: this statement ran while no tenant had been
 * established.
 */
export const UNRESOLVED_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000000';

/**
 * A read issued before a `TenantContext` exists.
 *
 * `query` only, and no `unscoped` — every statement on this runner is already unscoped, and
 * the constraints that replace the tenant predicate are declared up front rather than per
 * statement.
 */
export type BootstrapQueryRunner = Pick<TenantQueryRunner, 'query'>;

export interface BootstrapReadOptions {
  /** Correlates the guard events this read emits with the request that caused them. */
  readonly correlationId: string;
  /**
   * Why this read may skip the tenant predicate. Mandatory, recorded as a security event,
   * and should name the invariant rather than the caller — "resolving which organizations
   * this user is a member of" rather than "the resolver needs it".
   */
  readonly reason: string;
  /**
   * The tenant-owned tables this read is permitted to touch. Everything else in
   * `TENANT_TABLES` is refused.
   */
  readonly tables: readonly string[];
}

/**
 * Raised when a bootstrap read exceeds what it declared.
 *
 * Distinct from {@link import('./tenant-guard.js').TenantGuardViolation}: the guard says
 * "this statement has no tenant predicate", which on this path is expected and permitted.
 * This says "this statement went somewhere the escape hatch does not reach", which is not.
 */
export class BootstrapScopeViolation extends Error {
  constructor(message: string) {
    super(`Bootstrap read refused: ${message}`);
    this.name = 'BootstrapScopeViolation';
  }
}

/** The only statement kinds a bootstrap read may issue. */
const BOOTSTRAP_READ_KINDS: ReadonlySet<string> = new Set(['select', 'with']);

/**
 * The runner behind {@link TenantDatabase.bootstrapRead}.
 *
 * Three constraints stand in for the tenant predicate this path cannot carry, and they are
 * independent of each other on purpose:
 *
 * 1. **A mandatory, audited reason.** Same escape hatch the outbox relay uses, so every
 *    statement issued here appears as a security event with `allowedReason` set.
 * 2. **Read-only.** `select` and `with` only. An unscoped write is never a bootstrap
 *    concern: establishing which tenant a session belongs to is a question, not a change.
 *    Provisioning a new organization is a different operation needing its own review.
 * 3. **A declared table allowlist.** The escape hatch reaches identity and membership, and
 *    nothing else. Without this, "unscoped" would mean "every row in the database", and the
 *    resolver would be a more powerful primitive than anything it bootstraps.
 *
 * The table check uses {@link tenantTablesMentioned} rather than the analyser's understood
 * reference list, because a statement the analyser cannot parse must still be refused.
 */
function makeBootstrapRunner(
  connection: PoolConnection,
  options: TenantDatabaseOptions,
  read: BootstrapReadOptions,
): BootstrapQueryRunner {
  const allowed = new Set(read.tables);
  for (const table of allowed) {
    if (!isTenantTable(table)) {
      // A typo here would silently widen the allowlist rather than narrow it, because a
      // name that matches no tenant table constrains nothing.
      throw new BootstrapScopeViolation(`'${table}' is not a tenant-owned table`);
    }
  }

  return {
    query: async <T extends QueryResult>(
      sql: string,
      params: readonly SqlParameter[] = [],
      shape?: StatementShapeOptions,
    ) => {
      const analysis = assertTenantScoped(
        sql,
        params,
        { organizationId: UNRESOLVED_ORGANIZATION_ID, correlationId: read.correlationId },
        {
          mode: options.guardMode,
          ...(options.onGuardEvent ? { onEvent: options.onGuardEvent } : {}),
          allowUnscoped: { reason: read.reason },
        },
      );

      if (!BOOTSTRAP_READ_KINDS.has(analysis.kind)) {
        throw new BootstrapScopeViolation(
          `'${analysis.kind}' is not a read; the bootstrap path establishes which tenant a ` +
            `session belongs to and may never modify data`,
        );
      }

      const reached = tenantTablesMentioned(sql).filter((table) => !allowed.has(table));
      if (reached.length > 0) {
        throw new BootstrapScopeViolation(
          `statement touches ${reached.join(', ')}, which is outside the declared allowlist ` +
            `(${[...allowed].join(', ') || 'none'}); a read without a tenant predicate may not ` +
            `reach tenant data`,
        );
      }

      const [result] = await connection.query<T>(
        statementOptions(sql, shape),
        params as SqlParameter[],
      );
      return result;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The identity path — the statements that run before step 2, not only before step 3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A statement issued while no tenant is involved at all.
 *
 * Spec section 3 step 1 — "authenticate the current session and validate revocation/cutoff"
 * — happens *before* step 2 resolves an organization. It reads and writes `sessions`,
 * `session_refresh_tokens` and `users`, none of which is tenant-owned, so there is no
 * `organization_id` to predicate on and none is missing.
 *
 * This is a narrower path than {@link BootstrapQueryRunner}, not a wider one, and the
 * difference is worth being exact about:
 *
 * | | bootstrap read | identity work |
 * | --- | --- | --- |
 * | Tenant tables reachable | three, declared | **none** |
 * | Writes | refused | permitted |
 * | ADR-0001 layer 3 | **waived**, audited | **fully in force** |
 *
 * The last row is the one that matters. A bootstrap read is a hole in the guard with three
 * constraints around it. Identity work is not a hole: the guard runs in ordinary `enforce`
 * mode against {@link UNRESOLVED_ORGANIZATION_ID}, so a statement that reaches a tenant table
 * cannot bind a predicate to the nil UUID and is rejected exactly as any unscoped statement
 * would be. Writes are permitted here for the same reason they are refused there — a write
 * that cannot touch tenant data is not a tenant-isolation concern, and refresh rotation is
 * necessarily a write.
 */
export type IdentityQueryRunner = Pick<TenantQueryRunner, 'query'>;

export interface IdentityWorkOptions {
  /** Correlates any guard event this path raises with the request that caused it. */
  readonly correlationId: string;
  /**
   * The global tables this unit of work is permitted to touch. Every name must be registered
   * in `NON_TENANT_TABLES`, so reaching a table from here requires first declaring it global
   * in `tenant-guard.ts` — a reviewable edit, in the file that also decides what the guard
   * protects.
   */
  readonly tables: readonly string[];
}

/**
 * Raised when identity work strays outside the identity tables.
 *
 * Distinct from {@link import('./tenant-guard.js').TenantGuardViolation} because it fires
 * for a different reason and in one case the guard would not fire at all: under
 * `TENANT_GUARD_MODE=observe` the guard records and continues, and this still throws. A mode
 * set for a documented incident must not turn the identity path into a route to tenant data.
 */
export class IdentityScopeViolation extends Error {
  constructor(message: string) {
    super(`Identity statement refused: ${message}`);
    this.name = 'IdentityScopeViolation';
  }
}

function makeIdentityRunner(
  connection: PoolConnection,
  options: TenantDatabaseOptions,
  work: IdentityWorkOptions,
): IdentityQueryRunner {
  for (const table of work.tables) {
    if (!isNonTenantTable(table)) {
      throw new IdentityScopeViolation(
        `'${table}' is not registered as a global table in NON_TENANT_TABLES; identity work ` +
          `may only reach tables that carry no tenant key`,
      );
    }
  }

  return {
    query: async <T extends QueryResult>(
      sql: string,
      params: readonly SqlParameter[] = [],
      shape?: StatementShapeOptions,
    ) => {
      // Checked before the guard, and unconditionally. The guard is the general control and
      // would reject these statements too, but only in `enforce` mode; this one is the
      // specific promise this path makes, so it holds in both modes.
      const reached = tenantTablesMentioned(sql);
      if (reached.length > 0) {
        throw new IdentityScopeViolation(
          `statement touches ${reached.join(', ')}; the identity path runs before any ` +
            `organization has been resolved and can never be scoped to one`,
        );
      }

      // Ordinary enforcement, no waiver. Nothing here is exempt from ADR-0001 layer 3 —
      // there is simply nothing for it to object to.
      assertTenantScoped(
        sql,
        params,
        { organizationId: UNRESOLVED_ORGANIZATION_ID, correlationId: work.correlationId },
        {
          mode: options.guardMode,
          ...(options.onGuardEvent ? { onEvent: options.onGuardEvent } : {}),
        },
      );

      const [result] = await connection.query<T>(
        statementOptions(sql, shape),
        params as SqlParameter[],
      );
      return result;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TenantDatabase
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The organization-bound database handle.
 *
 * Repositories receive a {@link TenantQueryRunner}; nothing outside this module receives
 * the pool. The lint boundary in `eslint.config.js` (spec section 6) makes that structural
 * rather than conventional: feature code cannot import `mysql2` or this module's pool at
 * all.
 */
export class TenantDatabase {
  constructor(
    private readonly pool: Pool,
    private readonly options: TenantDatabaseOptions,
  ) {}

  /**
   * Run a unit of work in one transaction, on one connection, bound to one organization.
   *
   * Required for multi-write commands (section 6). Rollback on any thrown error is not a
   * nicety: spec section 3 step 8 puts the audit event and the outbox event in the same
   * transaction as the state change, so a partial commit would produce an event describing
   * something that did not happen.
   */
  async transaction<T>(
    context: TenantContext,
    work: (tx: TenantQueryRunner) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      try {
        const result = await work(makeRunner(connection, context, this.options));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        // Unwrapped here, at the one boundary every repository call returns through, so a
        // caller sees the tenant-guard refusal or the constraint violation itself rather
        // than an ORM wrapper that both hides it and repeats the bound parameters.
        throw unwrapQueryError(error);
      }
    } finally {
      connection.release();
    }
  }

  /**
   * A read that needs no transaction. Still guarded, still bound to one connection for the
   * duration, so a multi-statement read cannot interleave with another context's work.
   */
  async read<T>(context: TenantContext, work: (db: TenantQueryRunner) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      return await work(makeRunner(connection, context, this.options));
    } catch (error) {
      throw unwrapQueryError(error);
    } finally {
      connection.release();
    }
  }

  /**
   * The one read that runs before a tenant exists.
   *
   * Spec section 3 steps 1 to 3 describe a sequence with a bootstrapping problem in the
   * middle of it: the API "resolves the requested organization against an active internal or
   * client membership" and only then builds the `TenantContext`. That resolving read cannot
   * itself be tenant-scoped, because it is the thing that establishes the tenant. A
   * `WHERE organization_id = ?` bound to the organization the *request* asked for would
   * check the request against itself and prove nothing.
   *
   * So this is a deliberate hole in ADR-0001 layer 3, and it is made as small as three
   * independent constraints can make it — see {@link makeBootstrapRunner}. It is the same
   * audited escape the outbox relay uses, plus two limits the relay does not need.
   *
   * Not a transaction: a bootstrap read makes no changes, and one connection for the whole
   * resolution is what stops two statements of it seeing different snapshots of a membership
   * being revoked underneath them.
   */
  async bootstrapRead<T>(
    options: BootstrapReadOptions,
    work: (db: BootstrapQueryRunner) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      return await work(makeBootstrapRunner(connection, this.options, options));
    } catch (error) {
      throw unwrapQueryError(error);
    } finally {
      connection.release();
    }
  }

  /**
   * Read identity state — spec section 3 step 1, before any organization is named.
   *
   * Not a transaction: authenticating a request is a single consistent read and runs on
   * every request, so opening a transaction for it would cost a round trip per call for no
   * guarantee. See {@link IdentityQueryRunner} for why this is not an escape hatch.
   */
  async identityRead<T>(
    options: IdentityWorkOptions,
    work: (db: IdentityQueryRunner) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      return await work(makeIdentityRunner(connection, this.options, options));
    } catch (error) {
      throw unwrapQueryError(error);
    } finally {
      connection.release();
    }
  }

  /**
   * Change identity state atomically.
   *
   * Refresh rotation is the reason this exists. It is a compare-and-swap on the live token
   * hash plus an append to the superseded ledger, and the two must land together: a commit
   * that moved the hash without recording the old one would delete the evidence reuse
   * detection runs on, and one that recorded the old hash without moving it would report a
   * live token as replayed.
   */
  async identityTransaction<T>(
    options: IdentityWorkOptions,
    work: (tx: IdentityQueryRunner) => Promise<T>,
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      try {
        const result = await work(makeIdentityRunner(connection, this.options, options));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw unwrapQueryError(error);
      }
    } finally {
      connection.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
