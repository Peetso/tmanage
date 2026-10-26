import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { assertSafeAuditMetadata, auditObjectTypeFor, uuidv7 } from '@tmanage/domain';
import type { AuditAction, AuditMetadata, AuditResult } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { auditEvents } from '../../common/database/schema.js';
import type { AuditEventRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { actorAppAuditValue } from './actor-app.js';

/**
 * The append-only audit table — AUD-001, `25-AUTH-AND-TENANT-ISOLATION` §12.
 *
 * Same shape as every other repository in this codebase: `TenantContext` is the scoping
 * parameter, no input type carries an `organizationId`, and reads are keyset-paginated. Three
 * things about this one are different, and each is forced by what the table is.
 *
 * ## There is no update, and no delete
 *
 * Not omitted for want of a use case — they cannot exist. `0002_platform_primitives.sql`
 * installs `BEFORE UPDATE` and `BEFORE DELETE` triggers that `SIGNAL` on every row, and
 * `scripts/db/users.sql` grants the runtime credential `INSERT` and nothing else on this
 * table. A method here would compile, would pass review, and would fail at runtime against
 * every credential the application can hold. So the class does not offer one, which makes
 * the impossibility visible at the call site rather than at 3am.
 *
 * ## The metadata gate is at the write, not at the caller
 *
 * {@link append} calls `assertSafeAuditMetadata` before it builds a statement. Putting the
 * check in a service would leave the repository as an unguarded second door; putting it in
 * the domain and calling it *here* means every path into the table — a service, a test, a
 * future worker — passes through the same refusal. §12's "safe metadata" is only a property
 * of the system if it holds at the narrowest point every writer must cross.
 *
 * ## The object type comes from the action
 *
 * `objectType` is not an input. `auditObjectTypeFor()` derives it, so two call sites writing
 * `project_membership.revoked` cannot record `project_membership` and `projectMembership` and
 * make `ix_audit_events_org_object` useless for the one question it exists to answer.
 */

export class AuditActionResultError extends Error {
  constructor(
    readonly action: AuditAction,
    readonly result: AuditResult,
  ) {
    super(`Audit action ${action} cannot be recorded with result '${result}'`);
    this.name = 'AuditActionResultError';
  }
}

/**
 * Note what is absent, in the order it matters: `organizationId`, which comes from the
 * context; `objectType`, which comes from the action; `createdAt`, which comes from the
 * server; and `id`, which is generated here. What a caller supplies is what a caller knows.
 */
export interface AppendAuditEventInput {
  readonly action: AuditAction;
  readonly result: AuditResult;
  /** The row this describes. Null when the object is not a row — a capability, a procedure. */
  readonly objectId: string | null;
  /**
   * Who acted. Defaults to the context's user, which is the ordinary case; supplied
   * explicitly only when recording an action taken *by* one person *as* another, where
   * {@link AppendAuditEventInput.effectiveActorId} carries the second half.
   *
   * Null means system-initiated. It is a real case — an expiry job has no actor — and the
   * column is nullable for it, so `undefined` and `null` mean different things here and the
   * type says so.
   */
  readonly actorUserId?: string | null;
  /** Set only for impersonation and cross-tenant support (§10, §12). */
  readonly effectiveActorId?: string | null;
  readonly metadata: AuditMetadata;
}

export interface ListAuditEventsOptions {
  readonly action?: AuditAction;
  readonly actorUserId?: string;
  readonly objectType?: string;
  readonly objectId?: string;
  readonly result?: AuditResult;
  /**
   * Keyset cursor. Reads run **newest first**, so the cursor is exclusive-upper rather than
   * exclusive-lower: pass the id of the oldest row you have and receive the ones before it.
   */
  readonly before?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class AuditEventsRepository {
  /**
   * Append one event.
   *
   * Must be called inside the same transaction as the state change it describes — §3 step 8.
   * That is not enforceable from here: a `TenantQueryRunner` from `transaction()` and one from
   * `read()` are the same type, deliberately, so that a repository cannot behave differently
   * depending on how it was called. The obligation therefore sits with the service, and the
   * database suite has a case that proves a rolled-back transaction leaves no audit row —
   * which is the property that would actually be lost if a service got this wrong.
   *
   * The row is read back rather than reconstructed: `created_at` is `CURRENT_TIMESTAMP(3)` on
   * the server, and returning a locally-stamped object would let the returned value and the
   * stored one disagree by the round-trip time.
   */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendAuditEventInput,
  ): Promise<AuditEventRow> {
    // AUT-08. A request on the AI-assistant / MCP channel (a personal access token) stamps
    // `actor_channel` onto the row it writes, so a work item's activity feed can mark the move
    // "via AI assistant". The caller never sets this key, and an ordinary cookie session carries
    // no channel, so its metadata — and the stored row — are byte-for-byte what they were before.
    // The connected app's name rides along as `actor_app` (safe form; omitted when unknown).
    const actorApp =
      context.actorChannel !== undefined ? actorAppAuditValue(context.actorApp) : undefined;
    const metadata: AuditMetadata =
      context.actorChannel !== undefined && !('actor_channel' in input.metadata)
        ? {
            ...input.metadata,
            actor_channel: context.actorChannel,
            ...(actorApp !== undefined && !('actor_app' in input.metadata)
              ? { actor_app: actorApp }
              : {}),
          }
        : input.metadata;
    // Before anything else. A statement is never built from metadata that has not passed — and
    // the check is on the metadata actually written, the stamped `actor_channel` included.
    assertSafeAuditMetadata(metadata);

    if (input.action === 'security.capability_denied' && input.result !== 'denied') {
      // The action names a refusal. Recording one as `allowed` would put a row in the table
      // that reads as "this denial succeeded", which is not a thing that can happen.
      throw new AuditActionResultError(input.action, input.result);
    }
    if (input.action === 'file_asset.rejected' && input.result !== 'denied') {
      // FILE-002: a rejection is §12's "denied sensitive attempt". The grading is a rule
      // here rather than a comment on the catalog, so a later producer cannot file one as
      // `allowed` and make the security log read as if the file passed.
      throw new AuditActionResultError(input.action, input.result);
    }
    if (input.action === 'file_asset.scanned' && input.result !== 'allowed') {
      // FILE-002 slice B, the rule's mirror: `scanned` is the row that says a scanner
      // cleared the file and it was promoted. Filed as anything else it would read as a
      // clearance that was refused, which is `rejected` or `scan_failed`, never this.
      throw new AuditActionResultError(input.action, input.result);
    }

    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(auditEvents)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        actorUserId: input.actorUserId === undefined ? context.userId : input.actorUserId,
        effectiveActorId: input.effectiveActorId ?? null,
        action: input.action,
        objectType: auditObjectTypeFor(input.action),
        objectId: input.objectId,
        result: input.result,
        // From the context as well. An audit row whose correlation id did not match the
        // request that caused it would be worse than one with none: it would point at
        // another request's logs.
        correlationId: context.correlationId,
        metadataJson: metadata,
        // The server's clock, not this process's. `created_at` already defaults to
        // `CURRENT_TIMESTAMP(3)` in the DDL; the Drizzle description does not carry defaults,
        // so the value is supplied as an expression rather than as a literal — which keeps
        // the timestamp the database's in either case.
        createdAt: sql`current_timestamp(3)`,
      });

    return this.requireById(runner, context, id);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    auditEventId: string,
  ): Promise<AuditEventRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          eq(auditEvents.id, auditEventId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    auditEventId: string,
  ): Promise<AuditEventRow> {
    const found = await this.findById(runner, context, auditEventId);
    if (!found) {
      // No organization id in the message: an id that exists in another tenant and one that
      // exists nowhere must be indistinguishable to the caller (§4).
      throw new Error(`Audit event ${auditEventId} was not found`);
    }
    return found;
  }

  /**
   * The view-model read — AUD-001's second half, and ADMIN-002's data source.
   *
   * **Newest first**, because that is the only order an audit viewer is ever opened in, and a
   * default that has to be reversed by every caller is not a default.
   *
   * Ordering is by `id`, not by `created_at`. Both are time-ordered — ids are UUIDv7 — and
   * `id` is the one that is *unique*, so a page boundary can never repeat or skip a row that
   * shares a millisecond with its neighbour. The cost is precise and worth naming: `id` is
   * stamped when the writer generates it and `created_at` when the server commits it, so two
   * rows written by long transactions can order differently by the two columns. For an audit
   * trail that is the correct trade — a viewer that occasionally shows two near-simultaneous
   * events in generation order is fine; one that drops an event at a page boundary is not.
   *
   * Every filter is optional and every one of them is `AND`ed onto the tenant predicate, which
   * is not optional. `ix_audit_events_org_action_time`, `ix_audit_events_org_actor_time` and
   * `ix_audit_events_org_object` all lead with `organization_id` for the same reason every
   * index in `07-DATA-MODEL` §9 does: every legitimate query starts there.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListAuditEventsOptions = {},
  ): Promise<readonly AuditEventRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [eq(auditEvents.organizationId, context.organizationId)];
    if (options.action) predicates.push(eq(auditEvents.action, options.action));
    if (options.actorUserId) predicates.push(eq(auditEvents.actorUserId, options.actorUserId));
    if (options.objectType) predicates.push(eq(auditEvents.objectType, options.objectType));
    if (options.objectId) predicates.push(eq(auditEvents.objectId, options.objectId));
    if (options.result) predicates.push(eq(auditEvents.result, options.result));
    if (options.before) predicates.push(lt(auditEvents.id, options.before));

    return tenantDrizzle(runner)
      .select()
      .from(auditEvents)
      .where(and(...predicates))
      .orderBy(desc(auditEvents.id))
      .limit(limit);
  }

  /**
   * Everything recorded about one object, newest first.
   *
   * The object type is derived from the action rather than passed, so this takes the action's
   * object type from the caller's own vocabulary: `historyOf(runner, context, 'project_
   * membership', id)`. A free-text object type here would let a caller ask a question the
   * writers can never have answered.
   */
  async historyOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    objectType: string,
    objectId: string,
    options: Omit<ListAuditEventsOptions, 'objectType' | 'objectId'> = {},
  ): Promise<readonly AuditEventRow[]> {
    return this.list(runner, context, { ...options, objectType, objectId });
  }
}
