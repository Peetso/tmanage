import { describeAuditEvent, hasCapability, isSafeAuditMetadata } from '@tmanage/domain';
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

/**
 * ADM audit-viewer (x115). The narrow projection the Administration audit screen renders.
 *
 * Deliberately **narrower** than {@link AuditEventView}: it carries neither `metadata` nor
 * `correlationId` nor `effectiveActorId`. The rich view is safe by construction, but the viewer
 * is a broad, admin-facing list and the metadata column is the one place a producer's payload
 * lands — the x49/x58 OBS-001 redaction rule keeps request bodies, tokens and secrets out of a
 * broad read, so this projection omits the column entirely rather than trusting each writer. Every
 * field here is a stable identifier or a derived, non-sensitive `summary`; nothing a caller could
 * not already infer from the action they are entitled to see.
 */
export interface AdminAuditEventView {
  readonly id: string;
  /** The server's commit time, ISO-8601. `AuditEventView.createdAt` under the viewer's name. */
  readonly occurredAt: string;
  /** Who acted, or `null` for a system-initiated event. */
  readonly actorId: string | null;
  readonly action: string;
  /** The kind of object the action names — `AuditEventView.objectType`. */
  readonly entityType: string;
  /** The object the action names, or `null` when the action is not about a row. */
  readonly entityId: string | null;
  /**
   * Whether the action succeeded, was refused, or errored. Carried so the viewer can group the
   * flood of refusals (ADM-11) and tell a denial apart at a glance; an enum, never sensitive.
   */
  readonly result: AuditResult;
  /** A one-line, non-sensitive gloss derived from the action and its result. */
  readonly summary: string;
}

/**
 * The viewer's inputs. `actorId`/`entityId` are the caller's own vocabulary for the columns the
 * repository filters on (`actorUserId`/`objectId`); `before` is the keyset cursor and `limit` is
 * bounded by {@link AuditService.listForViewer}, not here. Named `…Options`, so the contracts gate
 * treats it as request-side and never enumerates it as a response shape.
 */
export interface AuditViewerListOptions {
  readonly limit?: number;
  readonly before?: string;
  readonly actorId?: string;
  readonly entityId?: string;
}

/**
 * Narrow a rich {@link AuditEventView} to the {@link AdminAuditEventView} the viewer renders.
 *
 * The `summary` is derived here rather than stored: `describeAuditEvent` turns the action into a
 * plain sentence (TXT-03 — "raw event codes" become "plain sentences"), naming the outcome when
 * it is a refusal or an error. It carries no metadata, so it cannot leak what the projection
 * deliberately dropped. The raw `action` and the `result` travel alongside it so the viewer can
 * still filter by the stable key and group the refusals (ADM-11).
 */
function toAdminAuditView(view: AuditEventView): AdminAuditEventView {
  return {
    id: view.id,
    occurredAt: view.createdAt,
    actorId: view.actorUserId,
    action: view.action,
    entityType: view.objectType,
    entityId: view.objectId,
    result: view.result,
    summary: describeAuditEvent(view.action, view.result),
  };
}

/** The viewer's page size — bounded far below the repository's ceiling. `x93`/`x98` precedent. */
const VIEWER_DEFAULT_PAGE_SIZE = 20;
const VIEWER_MAX_PAGE_SIZE = 50;

/**
 * The export's bounds — ADM-09 (x118). An export is a bulk egress, not a page, so it has a
 * different ceiling from the viewer and a hard stop rather than a cursor by default.
 *
 * - **`EXPORT_MAX_ROWS`** is the most rows one export may carry. Past it the request is refused
 *   with 413 rather than served: an unbounded audit trail must never become an unbounded table
 *   scan streamed to a client, and a caller who genuinely wants more narrows by filter or time.
 * - **`EXPORT_PAGE_SIZE`** is how the export reads — the repository's own ceiling — so the whole
 *   read is composed of the DB-proven {@link AuditEventsRepository.list}, keyset-paginated, and
 *   no new, separately-unproven query is introduced to reach the larger total.
 */
export const EXPORT_MAX_ROWS = 10_000;
const EXPORT_PAGE_SIZE = 200;

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

  /**
   * The Administration audit viewer — ADM (x115). A tenant-scoped, keyset-paginated, newest-first
   * read behind `audit.read`, projected to the narrow {@link AdminAuditEventView}.
   *
   * It composes {@link view} rather than re-querying: the capability gate (403 for a caller
   * without `audit.read`), the tenant scoping and the own-activity narrowing for a non-org-wide
   * caller all live there and are not restated here. Two things are this method's own:
   *
   *   - **The page is bounded to the viewer's ceiling**, `[1, 50]` with a default of 20 — narrower
   *     than the repository's own `[1, 200]`, because a broad admin list should not fetch a page
   *     that large in one read (`x93`/`x98` bounded-list precedent).
   *   - **The filters are tenant-safe by construction.** `actorId`/`entityId` become the
   *     repository's `actorUserId`/`objectId` equality predicates, each `AND`ed onto the
   *     non-optional tenant predicate. An unknown or cross-tenant filter id therefore yields an
   *     empty page — never a cross-tenant row and never a 500 — because there is no id resolution
   *     to miss (FAST-PROTOCOL Known trap): the id is a filter, not a lookup.
   */
  async listForViewer(
    context: TenantContext,
    principal: Principal,
    options: AuditViewerListOptions = {},
  ): Promise<readonly AdminAuditEventView[]> {
    const limit = Math.min(
      Math.max(options.limit ?? VIEWER_DEFAULT_PAGE_SIZE, 1),
      VIEWER_MAX_PAGE_SIZE,
    );

    const listOptions: ListAuditEventsOptions = {
      limit,
      ...(options.before ? { before: options.before } : {}),
      ...(options.actorId ? { actorUserId: options.actorId } : {}),
      ...(options.entityId ? { objectId: options.entityId } : {}),
    };

    const rows = await this.view(context, principal, listOptions);
    return rows.map(toAdminAuditView);
  }

  /**
   * The Administration audit export — ADM-09 (x118). The bulk-egress half of the audit surface,
   * and deliberately behind a **distinct, stronger** capability than the viewer.
   *
   * `audit.export` is not `audit.read`. Paging the trail interactively and exporting the whole of
   * it are different grants: the second is the one a departing admin would use to walk out with
   * the security log, so it is held by fewer roles (owner/admin) and gated separately. A caller
   * with `audit.read` but not `audit.export` gets **403**, which is the security point of this
   * slice — an empty export would falsely say "there is nothing to export".
   *
   * Everything else mirrors {@link listForViewer}, and for the same reasons:
   *
   *   - **Tenant scope and own-activity narrowing** are applied exactly as {@link view} applies
   *     them — org-wide for an org-wide principal, own-activity for everyone else — with the
   *     `actorUserId` overwrite last so a caller cannot widen past their own activity by naming
   *     another actor.
   *   - **`actorId`/`entityId` are filters, not lookups** (FAST-PROTOCOL Known trap): each becomes
   *     an equality predicate `AND`ed onto the non-optional tenant predicate, so an unknown or
   *     cross-tenant filter id yields an empty export — never a cross-tenant row, never a 500.
   *   - **The read is bounded.** It pages the DB-proven {@link AuditEventsRepository.list} by its
   *     keyset until the trail is exhausted or {@link EXPORT_MAX_ROWS} is exceeded; past the cap it
   *     refuses with 413 rather than scanning the whole table into one response.
   */
  async exportForViewer(
    context: TenantContext,
    principal: Principal,
    options: AuditViewerListOptions = {},
  ): Promise<readonly AdminAuditEventView[]> {
    if (!hasCapability(principal.role, 'audit.export')) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'audit_export_denied');
    }

    // The same composition as `listForViewer` → `view`: the caller's filters first, then the
    // tenant narrowing overwriting `actorUserId` last for a non-org-wide caller.
    const filtered: ListAuditEventsOptions = {
      ...(options.actorId ? { actorUserId: options.actorId } : {}),
      ...(options.entityId ? { objectId: options.entityId } : {}),
    };
    const scoped: ListAuditEventsOptions = principal.hasOrgWideScope
      ? filtered
      : { ...filtered, actorUserId: principal.userId };

    const rows = await this.database.read(context, async (runner) => {
      const collected: AuditEventRow[] = [];
      let cursor = options.before;
      for (;;) {
        const page = await this.events.list(runner, context, {
          ...scoped,
          ...(cursor ? { before: cursor } : {}),
          limit: EXPORT_PAGE_SIZE,
        });
        collected.push(...page);
        // One row past the cap is enough to know the export is too large; stop reading.
        if (collected.length > EXPORT_MAX_ROWS) break;
        // A short page is the end of the trail.
        if (page.length < EXPORT_PAGE_SIZE) break;
        cursor = page[page.length - 1]!.id;
      }
      return collected;
    });

    if (rows.length > EXPORT_MAX_ROWS) {
      throw new ApiError(
        413,
        'validation_failed',
        'The audit export is too large. Narrow it by actor, entity or time window and try again',
        [{ field: 'export', message: `exceeds the ${EXPORT_MAX_ROWS}-row export limit` }],
        'audit_export_too_large',
      );
    }

    return rows.map(toView).map(toAdminAuditView);
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
