import { and, eq, inArray } from 'drizzle-orm';
import type { ObjectStore } from '@tmanage/storage';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  authenticationEvents,
  clientInvoiceEvents,
  clientMemberships,
  credentialChangeNotices,
  marketingLeads,
  memberships,
  passwordResetTokens,
  platformAdmins,
  platformOwnerNotices,
  sessionRefreshTokens,
  sessions,
  userIdentities,
  userMfaFactors,
  userPasskeys,
  userMfaEmailCodes,
  userPasswords,
  userRecoveryCodes,
  users,
} from '../../common/database/schema.js';
import { TENANT_TABLES } from '../../common/database/tenant-guard.js';
import type {
  IdentityQueryRunner,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';

/**
 * H3 (audit gap 3, NFR-09, 33-LEGAL §8) — the erasure that follows a company deletion.
 *
 * The privacy job closes a company once its grace period ends (`privacy-job.ts`). A day later this
 * erases what the company held: first every stored file's bytes, then every row of every tenant
 * table, in batches. Rules it keeps:
 *
 * - **One tenant only.** Every statement is `… where organization_id = ?` under the company's own
 *   service context, so the tenant guard checks it like any other; an object key is removed only
 *   when it sits under the company's own `tenant/<id>/` prefix.
 * - **Batched and resumable.** Rows go `limit` {@link ErasureOptions.batchRows} at a time, each batch
 *   its own short transaction, and one run stops after {@link ErasureOptions.maxRowsPerRun} rows; the
 *   next pass carries on where it stopped. Running it again over an erased company finds nothing.
 * - **Foreign keys respected, never switched off.** Tables are tried children-first (the reverse of
 *   their registration order); a table still referenced by rows not deleted yet is retried in the
 *   next round. A table that stays refused after a round with no progress is reported as blocked,
 *   and the erasure is left incomplete rather than forced.
 * - **What is kept** ({@link RETAINED_TABLES}): the audit trail (append-only, retained by 33-LEGAL
 *   §7), its retention setting, the two privacy tables (the record of who asked for what and when),
 *   and the organization row itself, which those keep pointing at.
 */

export const RETAINED_TABLES: ReadonlySet<string> = new Set([
  'organizations',
  'audit_events',
  // 56-11: the chain head and anchors are the trail's tamper evidence and are kept with it (and
  // the runtime credential holds no DELETE on them).
  'audit_heads',
  'audit_anchors',
  'audit_retention_policy',
  'privacy_exports',
  'privacy_deletion_requests',
]);

/** Every tenant table the erasure empties, children-first (the reverse of registration order). */
export function erasableTables(
  registry: Readonly<Record<string, 'organization_id' | 'id'>> = TENANT_TABLES,
): readonly string[] {
  return Object.entries(registry)
    .filter(([table, column]) => column === 'organization_id' && !RETAINED_TABLES.has(table))
    .map(([table]) => table)
    .reverse();
}

export interface ErasureOptions {
  readonly batchRows: number;
  readonly maxRowsPerRun: number;
}

export const DEFAULT_ERASURE_OPTIONS: ErasureOptions = { batchRows: 500, maxRowsPerRun: 20_000 };

export interface ErasureOutcome {
  /** True when every erasable table is empty for the company and its files are gone. */
  readonly complete: boolean;
  readonly rowsErased: number;
  readonly objectsRemoved: number;
  /** Tables left with rows after a round without progress, and why (`referenced`, `refused`, …). */
  readonly blocked: Readonly<Record<string, string>>;
}

/** MariaDB errnos a refused DELETE can carry, and what they mean for the erasure. */
const ER_NO_SUCH_TABLE = 1146;
const ER_BAD_FIELD_ERROR = 1054;
const REFERENCED_ERRNOS: ReadonlySet<number> = new Set([1451, 1217]);
const BLOCKING_ERRNOS: Readonly<Record<number, string>> = {
  1451: 'referenced', // ER_ROW_IS_REFERENCED_2: a row elsewhere still points at it
  1217: 'referenced', // ER_ROW_IS_REFERENCED
  1644: 'refused', // ER_SIGNAL_EXCEPTION: a trigger refused the delete
  1142: 'not_permitted', // ER_TABLEACCESS_DENIED_ERROR: the credential holds no DELETE here
};

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function quoted(table: string): string {
  if (!IDENTIFIER.test(table)) throw new Error(`not a plain identifier: ${table}`);
  return `\`${table}\``;
}

function errnoOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const errno = (current as { errno?: unknown }).errno;
    if (typeof errno === 'number') return errno;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

type Drain =
  | { readonly state: 'empty'; readonly deleted: number }
  | { readonly state: 'budget'; readonly deleted: number }
  | { readonly state: 'blocked'; readonly deleted: number; readonly reason: string };

/** The stored objects a company's rows name, and the zones they may sit in. */
const OBJECT_SOURCES: readonly {
  readonly table: string;
  readonly zones: readonly ('quarantine' | 'private' | 'derived')[];
}[] = [
  { table: 'file_versions', zones: ['quarantine', 'private'] },
  { table: 'upload_sessions', zones: ['quarantine'] },
  // R4 slice 2 (0267): the derivatives TManage made of the company's files. A row whose
  // derivative was never written has a NULL key and is skipped by the prefix check below.
  { table: 'file_previews', zones: ['derived'] },
];

const KEY_PAGE = 500;

/**
 * Global (non-tenant) tables whose rows point at a tenant table's rows and would otherwise keep
 * them forever (wave 14 / L4). The OAuth connector's codes and tokens carry no `organization_id`
 * but reference `oauth_grants (id)`: before the company's grants go, the codes and tokens issued
 * under them are removed — they are dead credentials once the company is closed. Found by the
 * grant ids read under the company's own context, so nothing of another tenant is touched.
 */
const GLOBAL_DEPENDENTS: Readonly<
  Record<string, readonly { readonly table: string; readonly column: string }[]>
> = {
  oauth_grants: [
    { table: 'oauth_codes', column: 'grant_id' },
    { table: 'oauth_refresh_tokens', column: 'grant_id' },
    { table: 'oauth_access_tokens', column: 'grant_id' },
  ],
};

/** Rows a row-by-row pass reads per page (the fallback for a self-referencing table). */
const ROW_PAGE = 200;

export class CompanyErasure {
  constructor(
    private readonly database: TenantDatabase,
    private readonly store: Pick<ObjectStore, 'remove'>,
    private readonly tables: readonly string[] = erasableTables(),
    private readonly options: ErasureOptions = DEFAULT_ERASURE_OPTIONS,
  ) {}

  async run(context: TenantContext): Promise<ErasureOutcome> {
    const objectsRemoved = await this.removeStoredFiles(context);
    let budget = this.options.maxRowsPerRun;
    let rowsErased = 0;
    let pending = [...this.tables];
    let blocked: Record<string, string> = {};

    while (pending.length > 0) {
      const next: string[] = [];
      const refused: Record<string, string> = {};
      let progress = false;
      for (const table of pending) {
        if (budget <= 0) {
          return { complete: false, rowsErased, objectsRemoved, blocked: {} };
        }
        const drain = await this.drain(context, table, budget);
        rowsErased += drain.deleted;
        budget -= drain.deleted;
        if (drain.deleted > 0) progress = true;
        if (drain.state === 'empty') {
          progress = true;
          continue;
        }
        next.push(table);
        if (drain.state === 'blocked') refused[table] = drain.reason;
      }
      pending = next;
      blocked = refused;
      if (!progress) break;
    }

    return { complete: pending.length === 0, rowsErased, objectsRemoved, blocked };
  }

  /** Delete the company's rows of one table, a batch per transaction, until none or the budget. */
  private async drain(context: TenantContext, table: string, budget: number): Promise<Drain> {
    const dependents = await this.drainGlobalDependents(context, table, budget);
    if (dependents.state !== 'empty') return dependents;
    let deleted = dependents.deleted;
    for (;;) {
      const limit = Math.min(this.options.batchRows, budget - deleted);
      if (limit <= 0) return { state: 'budget', deleted };
      let count: number;
      try {
        count = await this.database.transaction(context, async (tx) =>
          affected(
            await tx.execute(
              `delete from ${quoted(table)} where organization_id = ? limit ${String(limit)}`,
              [context.organizationId],
            ),
          ),
        );
      } catch (error) {
        const errno = errnoOf(error);
        if (errno === ER_NO_SUCH_TABLE) return { state: 'empty', deleted };
        // InnoDB checks a foreign key row by row, in the order the DELETE visits rows, so a
        // self-referencing table (a thread reply → its root message, a nested folder → its
        // parent, a label assignment → its definition) refuses a batch that reaches a parent
        // before its child. Take that table row by row instead, children first.
        if (errno !== undefined && REFERENCED_ERRNOS.has(errno)) {
          return this.drainRowByRow(context, table, budget, deleted);
        }
        const reason = errno === undefined ? undefined : BLOCKING_ERRNOS[errno];
        if (reason !== undefined) return { state: 'blocked', deleted, reason };
        throw error;
      }
      deleted += count;
      if (count < limit) return { state: 'empty', deleted };
    }
  }

  /**
   * The fallback after a batch was refused as still referenced: the company's rows of the table,
   * newest first (UUIDv7 ids, so a reply or a child before what it points at), each in its own
   * delete. A row still referenced is skipped and retried in the next sweep; a sweep that removes
   * nothing reports the table `referenced` — a row elsewhere still points at it, and the next round
   * retries it after the other tables have drained. Each sweep removes at least one row or stops,
   * so it always ends.
   */
  private async drainRowByRow(
    context: TenantContext,
    table: string,
    budget: number,
    already: number,
  ): Promise<Drain> {
    let deleted = already;
    let removedHere = 0;
    let removedInSweep = 0;
    let before: string | null = null;
    for (;;) {
      let ids: readonly string[];
      try {
        const rows = (await this.database.read(context, (runner) =>
          runner.query(
            `select id from ${quoted(table)} where organization_id = ?${
              before === null ? '' : ' and id < ?'
            } order by id desc limit ${String(ROW_PAGE)}`,
            before === null ? [context.organizationId] : [context.organizationId, before],
          ),
        )) as unknown as readonly { id: unknown }[];
        ids = rows.map((row) => String(row.id));
      } catch (error) {
        // A table without an `id` column cannot be taken row by row; it stays referenced.
        if (errnoOf(error) === ER_BAD_FIELD_ERROR) {
          return { state: 'blocked', deleted, reason: 'referenced' };
        }
        throw error;
      }

      if (ids.length === 0) {
        if (before === null) {
          // Nothing left. (Nothing read at all right after a refusal is not taken as "empty".)
          return removedHere > 0
            ? { state: 'empty', deleted }
            : { state: 'blocked', deleted, reason: 'referenced' };
        }
        if (removedInSweep === 0) return { state: 'blocked', deleted, reason: 'referenced' };
        before = null;
        removedInSweep = 0;
        continue;
      }

      for (const id of ids) {
        if (deleted >= budget) return { state: 'budget', deleted };
        let count: number;
        try {
          count = await this.database.transaction(context, async (tx) =>
            affected(
              await tx.execute(
                `delete from ${quoted(table)} where organization_id = ? and id = ?`,
                [context.organizationId, id],
              ),
            ),
          );
        } catch (error) {
          const errno = errnoOf(error);
          if (errno !== undefined && REFERENCED_ERRNOS.has(errno)) continue;
          const reason = errno === undefined ? undefined : BLOCKING_ERRNOS[errno];
          if (reason !== undefined) return { state: 'blocked', deleted, reason };
          throw error;
        }
        deleted += count;
        removedHere += count;
        removedInSweep += count;
      }

      if (ids.length < ROW_PAGE) {
        // End of this sweep: start another over what is left, or stop if this one did nothing.
        if (removedInSweep === 0) return { state: 'blocked', deleted, reason: 'referenced' };
        before = null;
        removedInSweep = 0;
        continue;
      }
      before = ids[ids.length - 1] ?? null;
    }
  }

  /**
   * Remove the global rows {@link GLOBAL_DEPENDENTS} lists for `table` that point at this company's
   * rows of it, before the table itself is drained. `empty` when there were none (or none are
   * left); counted against the run's budget like any other row.
   */
  private async drainGlobalDependents(
    context: TenantContext,
    table: string,
    budget: number,
  ): Promise<Drain> {
    const dependents = GLOBAL_DEPENDENTS[table];
    if (dependents === undefined) return { state: 'empty', deleted: 0 };
    let deleted = 0;
    let after = '';
    for (;;) {
      let parents: readonly string[];
      try {
        const rows = (await this.database.read(context, (runner) =>
          runner.query(
            `select id from ${quoted(table)}
              where organization_id = ? and id > ? order by id limit ${String(ROW_PAGE)}`,
            [context.organizationId, after],
          ),
        )) as unknown as readonly { id: unknown }[];
        parents = rows.map((row) => String(row.id));
      } catch (error) {
        if (errnoOf(error) === ER_NO_SUCH_TABLE) return { state: 'empty', deleted };
        throw error;
      }
      if (parents.length === 0) return { state: 'empty', deleted };
      const marks = parents.map(() => '?').join(', ');
      for (const dependent of dependents) {
        if (deleted >= budget) return { state: 'budget', deleted };
        try {
          deleted += await this.database.transaction(context, async (tx) =>
            affected(
              await tx.execute(
                `delete from ${quoted(dependent.table)} where ${quoted(dependent.column)} in (${marks})`,
                [...parents],
              ),
            ),
          );
        } catch (error) {
          const errno = errnoOf(error);
          if (errno === ER_NO_SUCH_TABLE) continue;
          const reason = errno === undefined ? undefined : BLOCKING_ERRNOS[errno];
          if (reason !== undefined) return { state: 'blocked', deleted, reason };
          throw error;
        }
      }
      if (parents.length < ROW_PAGE) return { state: 'empty', deleted };
      after = parents[parents.length - 1] ?? '';
    }
  }

  /**
   * Remove the bytes every file row of the company names, from each zone they may be in. `remove`
   * is idempotent, so a run that stopped halfway simply repeats it. A key outside the company's
   * own prefix is never touched.
   */
  private async removeStoredFiles(context: TenantContext): Promise<number> {
    const prefix = `tenant/${context.organizationId}/`;
    let removed = 0;
    for (const source of OBJECT_SOURCES) {
      let after = '';
      for (;;) {
        let page: readonly { id: string; object_key: string }[];
        try {
          page = (await this.database.read(context, (runner) =>
            runner.query(
              `select id, object_key from ${quoted(source.table)}
                where organization_id = ? and id > ? order by id limit ${String(KEY_PAGE)}`,
              [context.organizationId, after],
            ),
          )) as unknown as readonly { id: string; object_key: string }[];
        } catch (error) {
          if (errnoOf(error) === ER_NO_SUCH_TABLE) break;
          throw error;
        }
        for (const row of page) {
          if (typeof row.object_key !== 'string' || !row.object_key.startsWith(prefix)) continue;
          for (const zone of source.zones) {
            await this.store.remove({ zone, objectKey: row.object_key });
          }
          removed += 1;
        }
        const last = page[page.length - 1];
        if (last === undefined || page.length < KEY_PAGE) break;
        after = last.id;
      }
    }
    return removed;
  }
}

// ── The erasure after an account deletion (56-18) ──────────────────────────────────────────────

/**
 * The global tables an account erasure reaches (all in `NON_TENANT_TABLES`): the credentials and
 * sessions that go, the account row and sign-in log that stay without the person, the marketing
 * enquiry and platform notices that named them, and the platform staff list it checks first.
 */
export const ACCOUNT_ERASURE_TABLES: readonly string[] = [
  'users',
  'sessions',
  'session_refresh_tokens',
  'user_passwords',
  'user_mfa_factors',
  'user_recovery_codes',
  'user_mfa_email_codes',
  'user_passkeys',
  'user_identities',
  'password_reset_tokens',
  'credential_change_notices',
  'authentication_events',
  'marketing_leads',
  'platform_owner_notices',
  'platform_admins',
];

/** The pseudonymised account: no name, an address that cannot receive mail, disabled. */
export const ERASED_DISPLAY_NAME = 'Former member';

export function erasedEmail(userId: string): string {
  return `erased-${userId}@erased.invalid`;
}

/** What happened to the global account once the person's company rows were redacted. */
export type AccountGlobalOutcome =
  'erased' | 'already_erased' | 'kept_other_memberships' | 'kept_platform_staff' | 'not_found';

export interface AccountErasureOutcome {
  /** Rows in the requesting company whose personal fields were nulled. */
  readonly tenantRowsRedacted: number;
  readonly global: AccountGlobalOutcome;
}

const FIND_MEMBERSHIPS_REASON =
  'checking whether a person whose account deletion was carried out still belongs to any ' +
  'organization, before their global account is erased (56-18, GDPR Art. 17)';

/**
 * 56-18 — the erasure that follows an executed account deletion, after the same delay as a
 * company's (run by the privacy job, `privacy-job.ts`). Two halves:
 *
 * - **The requesting company.** Under that company's own service context, the personal fields the
 *   inventory keeps redacted are nulled for this one person: the IP and user agent on the invoice
 *   event log (`client_invoice_events`, kept as a fiscal record). Every statement names the
 *   organization and the subject.
 * - **The global account**, only once the person belongs to no organization at all (no active or
 *   suspended membership or client membership anywhere): credentials, sessions, linked sign-ins,
 *   reset tokens and pending notices are deleted; the account row is pseudonymised; the sign-in
 *   log keeps its rows without IP, user agent or client hints; a marketing enquiry from the same
 *   address and platform notices sent to the person are deleted. Shared work keeps pointing at the
 *   account id, which now names no one. A platform staff member is never erased here (their staff
 *   record is offboarded by the operator).
 *
 * Nothing here is a new trigger: it runs only for a request the privacy job has already executed.
 * Running it again finds the account already erased and changes nothing.
 */
export class AccountErasure {
  constructor(
    private readonly database: TenantDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(context: TenantContext, subjectUserId: string): Promise<AccountErasureOutcome> {
    const tenantRowsRedacted = await this.redactInCompany(context, subjectUserId);
    const stillMember = await this.database.bootstrapRead(
      {
        correlationId: context.correlationId,
        reason: FIND_MEMBERSHIPS_REASON,
        tables: ['memberships', 'client_memberships'],
      },
      async (db) => {
        const member = await tenantDrizzle(db)
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, subjectUserId),
              inArray(memberships.status, ['active', 'suspended']),
            ),
          )
          .limit(1);
        if (member.length > 0) return true;
        const client = await tenantDrizzle(db)
          .select({ id: clientMemberships.id })
          .from(clientMemberships)
          .where(
            and(
              eq(clientMemberships.userId, subjectUserId),
              inArray(clientMemberships.status, ['active', 'suspended']),
            ),
          )
          .limit(1);
        return client.length > 0;
      },
    );
    if (stillMember) return { tenantRowsRedacted, global: 'kept_other_memberships' };
    const global = await this.database.identityTransaction(
      { correlationId: context.correlationId, tables: ACCOUNT_ERASURE_TABLES },
      (tx) => this.eraseAccount(tx, subjectUserId),
    );
    return { tenantRowsRedacted, global };
  }

  /** Null the person's IP and user agent on this company's invoice event log. */
  private async redactInCompany(context: TenantContext, subjectUserId: string): Promise<number> {
    return this.database.transaction(context, async (tx) =>
      affected(
        await tenantDrizzle(tx)
          .update(clientInvoiceEvents)
          .set({ ip: null, ua: null })
          .where(
            and(
              eq(clientInvoiceEvents.organizationId, context.organizationId),
              eq(clientInvoiceEvents.actorId, subjectUserId),
            ),
          ),
      ),
    );
  }

  private async eraseAccount(
    tx: IdentityQueryRunner,
    userId: string,
  ): Promise<AccountGlobalOutcome> {
    const db = tenantDrizzle(tx);
    const account = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update');
    const email = account[0]?.email;
    if (email === undefined) return 'not_found';
    if (email === erasedEmail(userId)) return 'already_erased';
    const staff = await db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(eq(platformAdmins.userId, userId))
      .limit(1);
    if (staff.length > 0) return 'kept_platform_staff';

    const ownSessions = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId));
    await db
      .delete(sessionRefreshTokens)
      .where(inArray(sessionRefreshTokens.sessionId, ownSessions));
    await db.delete(sessions).where(eq(sessions.userId, userId));
    await db.delete(userPasswords).where(eq(userPasswords.userId, userId));
    await db.delete(userMfaFactors).where(eq(userMfaFactors.userId, userId));
    await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await db.delete(userMfaEmailCodes).where(eq(userMfaEmailCodes.userId, userId));
    await db.delete(userPasskeys).where(eq(userPasskeys.userId, userId));
    await db.delete(userIdentities).where(eq(userIdentities.userId, userId));
    await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
    await db.delete(credentialChangeNotices).where(eq(credentialChangeNotices.userId, userId));
    await db.delete(platformOwnerNotices).where(eq(platformOwnerNotices.ownerUserId, userId));
    // The column's collation compares the address without case, as the enquiry form stored it.
    await db.delete(marketingLeads).where(eq(marketingLeads.email, email));
    await db
      .update(authenticationEvents)
      .set({ ip: null, userAgent: null, clientHints: null })
      .where(eq(authenticationEvents.userId, userId));
    const at = this.now();
    await db
      .update(users)
      .set({
        email: erasedEmail(userId),
        displayName: ERASED_DISPLAY_NAME,
        emailVerifiedAt: null,
        disabledAt: at,
        disabledReason: null,
        updatedAt: at,
      })
      .where(eq(users.id, userId));
    return 'erased';
  }
}
