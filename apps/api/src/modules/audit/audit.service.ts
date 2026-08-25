import { hasCapability, isSafeAuditMetadata } from '@tmanage/domain';
import type { AuditAction, AuditMetadata, AuditResult, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import { AuditEventsRepository } from './audit-events.repository.js';
import type { AppendAuditEventInput, ListAuditEventsOptions } from './audit-events.repository.js';
import type { AuditEventRow } from '../../common/database/schema.js';

/**
 * The audit service — AUD-001.
 *
 * Two verbs, and they are deliberately not symmetrical.
 *
 * ## `record` joins the caller's transaction; it never opens one
 *
 * `25-AUTH-AND-TENANT-ISOLATION` §3 step 8 requires the audit event and the state change to
 * commit together. A service that opened its own transaction would satisfy the letter of
 * "an audit row was written" and break the property that matters: a rolled-back role change
 * would leave a record saying the role changed. So {@link record} takes the caller's
 * `TenantQueryRunner` and nothing else. It has no access to a pool and cannot start a
 * transaction even by mistake.
 *
 * ## `recordDenial` opens its own, and swallows its failures
 *
 * A refusal has no state change to be atomic with — that is what makes it a refusal — and by
 * the time one is being recorded the response has already been decided. Two consequences,
 * both uncomfortable enough to be worth stating rather than discovering:
 *
 * 1. **It must not throw.** The exception filter is the only caller. An audit write that
 *    turned a 403 into a 500 would tell the caller *more* because the server tried to record
 *    that it was telling them less, and would convert a routine denial into an outage the
 *    moment the database was briefly unavailable.
 * 2. **Therefore a denial can be lost.** Recorded here rather than papered over: this is a
 *    best-effort security log, and the durable one is the state-changing path. §12 asks for
 *    denied sensitive attempts to be security events; it does not make them transactional,
 *    and nothing here can make a write to a database that is down succeed.
 *
 * ## The view model is narrowed, and not as far as `12-PERMISSION-MATRIX` §2 asks
 *
 * §2's audit row reads: Owner **Full**, Admin **Full**, Workspace Admin **Workspace scope**,
 * Project Lead **Project sensitive subset**, Manager **Own activity**, Client Admin
 * **Client-side subset**, Client Reviewer **Own decisions**.
 *
 * Two of those are expressible today and five are not, because `audit_events` carries
 * `organization_id`, `actor_user_id`, `object_type` and `object_id` — and no `workspace_id`,
 * no `project_id` and no `client_organization_id`. {@link view} therefore implements the two
 * it can prove and takes the **narrower** reading for everything else: organization-wide for
 * a principal with organization-wide scope, own-activity for everyone else who holds
 * `audit.read`. A Workspace Admin consequently sees less than §2 permits, not more. The gap
 * is recorded in `docs/implementation-status.md`; closing it needs columns on the table and a
 * migration, which is a schema decision rather than a service one.
 */

/** What a caller may see of an audit event. An explicit projection — §7. */
export interface AuditEventView {
  readonly id: string;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly result: AuditResult;
  readonly actorUserId: string | null;
  readonly effectiveActorId: string | null;
  readonly correlationId: string;
  readonly metadata: unknown;
  readonly createdAt: string;
}

/**
 * `organization_id` is deliberately absent, as it is from `ProjectView`: the caller already
 * knows which organization they asked about, and echoing a tenant identifier into a response
 * body is how one ends up quoted in a client's bug report.
 */
function toView(row: AuditEventRow): AuditEventView {
  return {
    id: row.id,
    action: row.action,
    objectType: row.objectType,
    objectId: row.objectId,
    result: row.result,
    actorUserId: row.actorUserId,
    effectiveActorId: row.effectiveActorId,
    correlationId: row.correlationId,
    // Safe by construction: nothing reaches this column without passing
    // `assertSafeAuditMetadata` at the repository's write boundary.
    metadata: row.metadataJson,
    createdAt: row.createdAt.toISOString(),
  };
}

/** What the exception filter knows about a refusal. Not a domain event; a security one. */
export interface DenialRecord {
  /** The capability the route declared, when it declared one. */
  readonly capability?: string;
  /** `ApiError.auditCode` — the specific cause the response deliberately does not carry. */
  readonly auditCode?: string;
  /** The HTTP status the caller received. */
  readonly status: number;
}

export class AuditService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly events: AuditEventsRepository = new AuditEventsRepository(),
  ) {}

  /**
   * Append an event inside the caller's unit of work.
   *
   * Throws if the metadata is unsafe, and that is the intended behaviour on this path: a
   * command whose audit record cannot be written safely must not commit its state change
   * either. The alternative — commit the change, drop the record — is the exact failure §12
   * exists to prevent.
   */
  async record(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendAuditEventInput,
  ): Promise<AuditEventRow> {
    return this.events.append(runner, context, input);
  }

  /**
   * Record a refused attempt. Never throws, and returns whether anything was written.
   *
   * The metadata is checked with the non-throwing `isSafeAuditMetadata` and replaced wholesale
   * if it fails, rather than being written unchecked or dropped silently. A denial whose
   * detail could not be recorded safely is still a denial worth counting.
   */
  async recordDenial(
    context: TenantContext,
    action: AuditAction,
    denial: DenialRecord,
  ): Promise<boolean> {
    const metadata: AuditMetadata = {
      http_status: denial.status,
      ...(denial.capability ? { capability: denial.capability } : {}),
      ...(denial.auditCode ? { audit_code: denial.auditCode } : {}),
      principal_kind: context.principalKind,
    };

    try {
      const safe: AuditMetadata = isSafeAuditMetadata(metadata)
        ? metadata
        : { metadata_was_unsafe: true, http_status: denial.status };

      await this.database.transaction(context, (tx) =>
        this.events.append(tx, context, {
          action,
          result: 'denied',
          objectId: null,
          metadata: safe,
        }),
      );
      return true;
    } catch {
      // Deliberately swallowed — see the note at the top of this file. The caller is the
      // exception filter, already committed to a response.
      return false;
    }
  }

  /**
   * The view model. `audit.read` plus the scope narrowing this table can actually support.
   *
   * A principal without `audit.read` gets **403**, not an empty list. An empty list would say
   * "there is nothing to see", which is a different and false statement.
   */
  async view(
    context: TenantContext,
    principal: Principal,
    options: ListAuditEventsOptions = {},
  ): Promise<readonly AuditEventView[]> {
    if (!hasCapability(principal.role, 'audit.read')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'audit_read_denied');
    }

    // The narrowing, and it is applied *after* the caller's own filters rather than merged
    // with them: a caller who asks for another user's activity and is only entitled to their
    // own must receive their own, not a silent widening. Overwriting the key last is what
    // guarantees the order cannot be reversed by a future edit to the object literal.
    const scoped: ListAuditEventsOptions = principal.hasOrgWideScope
      ? options
      : { ...options, actorUserId: principal.userId };

    const rows = await this.database.read(context, (runner) =>
      this.events.list(runner, context, scoped),
    );
    return rows.map(toView);
  }

  /** Everything recorded about one object, subject to the same narrowing as {@link view}. */
  async historyOf(
    context: TenantContext,
    principal: Principal,
    objectType: string,
    objectId: string,
    options: Omit<ListAuditEventsOptions, 'objectType' | 'objectId'> = {},
  ): Promise<readonly AuditEventView[]> {
    return this.view(context, principal, { ...options, objectType, objectId });
  }
}
