import type {
  IdentityQueryRunner,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { requestOriginOf } from '../../common/http/request-origin.js';
import { redactedJson } from '../audit/audit-redaction.js';
import { optionalReason, requireReason } from './platform-admin.access.js';
import type { PlatformAdminActor } from './platform-admin.guard.js';
import { insertPlatformAudit } from './platform-admin.repository.js';
import type { PlatformAuditInput } from './platform-admin.repository.js';

/** The writer and its statement live with the other platform SQL (lint: raw SQL in repositories). */
export { PLATFORM_AUDIT_INSERT_SQL, insertPlatformAudit } from './platform-admin.repository.js';

/**
 * The platform audit log writer (platform-admin v2, SPEC P6, §6 0239).
 *
 * Every platform action lands in `platform_admin_audit_events` with who (actor), what (action,
 * target), where (organization, support session), what changed (before/after, redacted by
 * `audit-redaction.ts`), from where (IP, device — trust-proxy aware, `request-origin.ts`) and why
 * (the reason: required on the destructive list, optional elsewhere).
 *
 * Two ways to write, like `AuditService`:
 * - {@link PlatformAuditService.insert} joins the caller's transaction, so the change and its row
 *   commit together (team edits, settings, suspension);
 * - {@link PlatformAuditService.record} writes one row in a transaction of its own, for an action
 *   with no state change to be atomic with (an email sent, a detail opened).
 *
 * Other slices call these; they never write the table themselves.
 */

const AUDIT_TABLES = ['platform_admin_audit_events'] as const;

/** The request facts every audit row carries. `RequestContext` of the platform services fits. */
export interface PlatformAuditRequestContext {
  readonly correlationId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * The row for an action whose reason the caller has already checked (`requireReason` or
 * `optionalReason`): who from the actor, IP and device from the request context.
 */
export function platformAuditFor(
  actor: Pick<PlatformAdminActor, 'account' | 'via'>,
  context: PlatformAuditRequestContext,
  fields: Omit<PlatformAuditInput, 'actorUserId' | 'actorEmail' | 'correlationId'>,
): PlatformAuditInput {
  return {
    actorUserId: actor.account.userId,
    actorEmail: actor.account.email,
    correlationId: context.correlationId,
    ip: context.ip,
    userAgent: context.userAgent,
    ...viaOf(actor),
    ...fields,
  };
}

/**
 * ADR-0015 point 9 / F10: the AI client and pending action of an AI-run platform request, read
 * from the actor the guard proved (never from the request body). Empty for a person's own click.
 */
export function viaOf(
  actor: Pick<PlatformAdminActor, 'via'>,
): Pick<PlatformAuditInput, 'aiClientName' | 'aiPendingActionId'> {
  const via = actor.via;
  if (via === undefined) return {};
  return { aiClientName: via.clientName.slice(0, 190), aiPendingActionId: via.pendingActionId };
}

export interface PlatformAuditRecordInput {
  readonly actor: Pick<PlatformAdminActor, 'account' | 'via'>;
  readonly action: string;
  readonly targetType: PlatformAuditInput['targetType'];
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly organizationId?: string | null;
  readonly supportSessionId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  /** The raw reason from the request body. */
  readonly reason: unknown;
  /** `true` on the destructive list (SPEC P6): a missing reason is a 400 and nothing is written. */
  readonly reasonRequired: boolean;
  /** The HTTP request (for IP and device), or an already-extracted origin. */
  readonly request?: object | { readonly ip: string | null; readonly userAgent: string | null };
  readonly correlationId: string;
}

export class PlatformAuditService {
  constructor(private readonly database: TenantDatabase) {}

  /**
   * Build the row: reason checked (required or optional), before/after redacted, origin read.
   * Throws the 400 for a missing required reason BEFORE anything is written, so a caller that
   * builds its row first and writes second changes nothing on a refusal.
   */
  build(input: PlatformAuditRecordInput): PlatformAuditInput {
    const reason = input.reasonRequired
      ? requireReason(input.reason)
      : optionalReason(input.reason);
    const origin = originOf(input.request);
    return {
      actorUserId: input.actor.account.userId,
      actorEmail: input.actor.account.email,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel,
      reason,
      correlationId: input.correlationId,
      organizationId: input.organizationId ?? null,
      supportSessionId: input.supportSessionId ?? null,
      beforeJson: redactedJson(input.before),
      afterJson: redactedJson(input.after),
      ip: origin.ip,
      userAgent: origin.userAgent,
      ...viaOf(input.actor),
    };
  }

  /** Join the caller's transaction. */
  async insert(
    tx: IdentityQueryRunner | TenantQueryRunner,
    audit: PlatformAuditInput,
  ): Promise<void> {
    await insertPlatformAudit(tx, audit);
  }

  /** One row in a transaction of its own. Returns the row it wrote. */
  async record(input: PlatformAuditRecordInput): Promise<PlatformAuditInput> {
    const audit = this.build(input);
    await this.database.identityTransaction(
      { correlationId: audit.correlationId, tables: [...AUDIT_TABLES] },
      (tx) => insertPlatformAudit(tx, audit),
    );
    return audit;
  }
}

function originOf(request: PlatformAuditRecordInput['request']): {
  ip: string | null;
  userAgent: string | null;
} {
  if (request === undefined) return { ip: null, userAgent: null };
  if ('userAgent' in request && !('headers' in request)) {
    const given = request as { ip: string | null; userAgent: string | null };
    return { ip: given.ip ?? null, userAgent: given.userAgent ?? null };
  }
  return requestOriginOf(request);
}
