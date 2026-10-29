import { auditActionLabel, isSafeAuditMetadata, uuidv7 } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { ApiError } from '../../../common/http/errors.js';
import {
  isPlatformAdminEmail,
  optionalReason,
  requireId,
  requireReason,
} from '../platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import { MAX_PLATFORM_AUDIT } from '../platform-admin.repository.js';
import type { PlatformAuditEventView, RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import type { PlatformSupportSessionView } from '../support/support-session.service.js';
import { toView as supportSessionView } from '../support/support-session.service.js';
import type { SupportSessionsRepository } from '../support/support-sessions.repository.js';
import {
  decodeCursor,
  optionalId,
  optionalText,
  pageOf,
  pageSize,
  parseActionFilter,
  parsePlatformActionFilter,
  parseSessionFilter,
  parseSignInFilter,
} from './activity-query.repository.js';
import type {
  ActionRow,
  ActivityRepository,
  SessionRow,
  SignInRow,
} from './activity.repository.js';
import {
  EXPORT_LIST_LIMIT,
  EXPORT_ROW_CAP,
  exportFileName,
  exportObjectKey,
  normalizeFilter,
  parseFilterJson,
  requireScope,
  signInsToCsv,
  viewStatus,
} from './exports.js';
import type { ExportJobRecord, ExportsRepository } from './exports.repository.js';
import { detectSuspicious, parseWindow, windowStart } from './suspicious.js';

/**
 * Platform admin · Activity & access (platform-admin v2 · PA-09, SPEC §4 C1–C6, §5.5) — every
 * view the routes answer with. Each is paired Exact with `apps/web/src/lib/api/platform-activity.ts`
 * in `e2e/contracts/api-web-shapes.ts`.
 *
 * IPs and devices are `null` unless the admin holds `platform.activity.detail` (SPEC §3.1).
 */

/** One org action (C1 row). */
export interface PlatformActionView {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly actorName: string | null;
  readonly effectiveActorUserId: string | null;
  readonly effectiveActorEmail: string | null;
  readonly effectiveActorName: string | null;
  readonly action: string;
  /** The action in plain words (`auditActionLabel`). */
  readonly actionLabel: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly result: 'allowed' | 'denied' | 'error';
  readonly correlationId: string;
  readonly supportSessionId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: string;
}

/** The summary line over the filter (C1: "2,418 actions · 37 via support · 12 denied · 3 errors"). */
export interface PlatformActionTotalsView {
  readonly total: number;
  readonly viaSupport: number;
  readonly denied: number;
  readonly errors: number;
}

/** `GET /v1/platform/activity/actions` */
export interface PlatformActionsPageView {
  readonly actions: readonly PlatformActionView[];
  readonly totals: PlatformActionTotalsView;
  /** Pass back as `cursor` for the next page; `null` on the last one. */
  readonly nextCursor: string | null;
  /** IPs and devices are shown (the admin holds `platform.activity.detail`). */
  readonly showsOrigin: boolean;
}

/** One before → after field (C2). A redacted field carries no values. */
export interface PlatformActionChangeView {
  readonly field: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly redacted: boolean;
}

/** Another event of the same request (C2 "Same request"). */
export interface PlatformRelatedActionView {
  readonly id: string;
  readonly action: string;
  readonly actionLabel: string;
  readonly result: 'allowed' | 'denied' | 'error';
  readonly occurredAt: string;
}

/** The Support session an event was taken in (C2 Who). */
export interface PlatformActionSupportSessionView {
  readonly id: string;
  readonly adminEmail: string;
  readonly reason: string | null;
  readonly startedAt: string;
}

/** `GET /v1/platform/activity/actions/:organizationId/:eventId` (C2). */
export interface PlatformActionDetailView {
  readonly action: PlatformActionView;
  /** The actor's role in this organization (`platform_support` for a support visit). */
  readonly actorRole: string | null;
  readonly supportSession: PlatformActionSupportSessionView | null;
  /** The safe metadata (ids and classifications only, `isSafeAuditMetadata`). */
  readonly metadata: Readonly<Record<string, string>>;
  /** Empty for older events, and for refusals (nothing changed). */
  readonly changes: readonly PlatformActionChangeView[];
  readonly sameCorrelation: readonly PlatformRelatedActionView[];
}

/** One sign-in attempt (C3 Sign-ins, `authentication_events`). */
export interface PlatformSignInView {
  readonly id: string;
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: string | null;
  readonly occurredAt: string;
}

export interface PlatformSignInsPageView {
  readonly signIns: readonly PlatformSignInView[];
  readonly nextCursor: string | null;
}

/** One browser session platform-wide (C3 Live sessions). */
export interface PlatformLiveSessionView {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly isPlatformAdmin: boolean;
  readonly userAgent: string | null;
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly active: boolean;
}

export interface PlatformLiveSessionsPageView {
  readonly sessions: readonly PlatformLiveSessionView[];
  readonly nextCursor: string | null;
}

/** `DELETE /v1/platform/activity/access/sessions/:sessionId` */
export interface PlatformSessionEndedView {
  readonly ended: true;
  readonly userId: string;
}

/** One step-up: a platform admin's confirmation, or a member's re-authentication. */
export interface PlatformStepUpView {
  readonly id: string;
  readonly kind: 'platform' | 'member';
  readonly userId: string | null;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly outcome: string;
  readonly mfaVerified: boolean;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: string;
  readonly expiresAt: string | null;
}

export interface PlatformStepUpsPageView {
  readonly stepUps: readonly PlatformStepUpView[];
  readonly nextCursor: string | null;
}

/** One unusual pattern (C3 Suspicious). */
export interface PlatformSuspiciousPatternView {
  readonly kind: 'ip_burst' | 'repeated_failures';
  /** The IP (burst) or the account's email / id (repeated failures). */
  readonly source: string;
  readonly userId: string | null;
  readonly accountsHit: number;
  readonly failures: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly status: 'open' | 'locked';
}

/** `GET /v1/platform/activity/access/suspicious?window=` */
export interface PlatformSuspiciousView {
  readonly window: '1h' | '24h' | '7d';
  readonly patterns: readonly PlatformSuspiciousPatternView[];
  /** Sign-in from a new country needs a location lookup that is not switched on yet. */
  readonly geoAvailable: boolean;
}

/** One platform admin action (C4, `platform_admin_audit_events`). */
export interface PlatformAdminActionView {
  readonly id: string;
  readonly actorUserId: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly reason: string | null;
  readonly supportSessionId: string | null;
  readonly correlationId: string;
  /** Redacted JSON, `null` without `platform.activity.detail`. */
  readonly beforeJson: string | null;
  readonly afterJson: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: string;
}

export interface PlatformAdminActionsPageView {
  readonly actions: readonly PlatformAdminActionView[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export type PlatformExportScope =
  'actions' | 'sign-ins' | 'sessions' | 'platform' | 'orgs' | 'people';

export type PlatformExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

/** One CSV export (C6). */
export interface PlatformExportJobView {
  readonly id: string;
  readonly scope: PlatformExportScope;
  readonly filter: Readonly<Record<string, string>>;
  readonly status: PlatformExportStatus;
  readonly requestedByUserId: string;
  readonly requestedByEmail: string;
  readonly requestedByName: string;
  readonly rowCount: number | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly expiresAt: string | null;
}

export interface PlatformExportJobsView {
  readonly exports: readonly PlatformExportJobView[];
}

/**
 * Platform admin · Activity & access (platform-admin v2 · PA-09, SPEC §4 C1–C6, §5.5).
 *
 * - C1 action log over `audit_events` (metadata path), keyset paged, every filter of §5.5;
 * - C2 one event's detail (tenant path for ONE organization) — itself audited
 *   `platform.action_detail_viewed`;
 * - C3 access: sign-ins, live sessions (end one, reason required), step-ups, suspicious;
 * - C4 the platform admins' own log (`GET audit` stays as the PA-02 alias);
 * - C5 every Support session (PA-05's repository), open ones first;
 * - C6 CSV exports: a queued job the worker writes (sign-ins: the API writes it), a 24-hour file.
 *
 * IPs and devices are shown only to an admin holding `platform.activity.detail` (SPEC §3.1).
 */

/** Under this, an open Support session is "ending soon" (C5 amber). */
export const SUPPORT_ENDING_SOON_MS = 5 * 60 * 1000;
const SUPPORT_LIST_LIMIT = 200;

export interface ActivityServiceDeps {
  readonly admins: PlatformAdminRepository;
  readonly activity: ActivityRepository;
  readonly exports: ExportsRepository;
  readonly supportSessions: SupportSessionsRepository;
  readonly audit: PlatformAuditService;
  readonly allowlist: readonly string[];
  readonly objectStore: ObjectStore | null;
  readonly now?: () => Date;
}

export interface ExportDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly stream: NodeJS.ReadableStream;
}

/** The support sessions C5 lists: the PA-05 view, open ones first. */
export interface PlatformActivitySupportSessionsView {
  readonly sessions: readonly PlatformSupportSessionView[];
  readonly openCount: number;
}

function canSeeDetail(actor: PlatformAdminActor): boolean {
  return (actor.permissions ?? []).includes('platform.activity.detail');
}

export function actionView(row: ActionRow, showOrigin: boolean): PlatformActionView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    actorName: row.actorName,
    effectiveActorUserId: row.effectiveActorUserId,
    effectiveActorEmail: row.effectiveActorEmail,
    effectiveActorName: row.effectiveActorName,
    action: row.action,
    actionLabel: auditActionLabel(row.action),
    objectType: row.objectType,
    objectId: row.objectId,
    result: row.result,
    correlationId: row.correlationId,
    supportSessionId: row.supportSessionId,
    ip: showOrigin ? row.ip : null,
    userAgent: showOrigin ? row.userAgent : null,
    occurredAt: row.createdAt.toISOString(),
  };
}

function signInView(row: SignInRow, showOrigin: boolean): PlatformSignInView {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    action: row.action,
    outcome: row.outcome,
    reason: row.reason,
    ip: showOrigin ? row.ip : null,
    userAgent: showOrigin ? row.userAgent : null,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

function metadataView(json: string | null): Readonly<Record<string, string>> {
  if (json === null) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!isSafeAuditMetadata(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      out[key] = Array.isArray(value) ? value.map(String).join(', ') : String(value);
    }
    return out;
  } catch {
    return {};
  }
}

export class PlatformActivityService {
  private readonly now: () => Date;

  constructor(private readonly deps: ActivityServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── PA-02's alias: `GET /v1/platform/audit` ─────────────────────────────────

  async auditLog(
    context: RequestContext,
  ): Promise<{ readonly events: readonly PlatformAuditEventView[] }> {
    const rows = await this.deps.admins.listAudit(MAX_PLATFORM_AUDIT, context.correlationId);
    return {
      events: rows.map((row) => ({
        id: row.id,
        actorEmail: row.actorEmail,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        targetLabel: row.targetLabel,
        reason: row.reason,
        occurredAt: row.createdAt.toISOString(),
      })),
    };
  }

  // ── C1 ───────────────────────────────────────────────────────────────────────

  async actions(
    actor: PlatformAdminActor,
    query: Record<string, unknown>,
    context: PlatformRequestContext,
  ): Promise<PlatformActionsPageView> {
    const filter = parseActionFilter(query);
    const cursor = decodeCursor(query['cursor']);
    const limit = pageSize(query['limit']);
    const rows = await this.deps.activity.listActions(filter, cursor, limit, context.correlationId);
    const page = pageOf(rows, limit, (row) => ({ at: row.createdAt, id: row.id }));
    const totals = await this.deps.activity.actionTotals(filter, context.correlationId);
    const showsOrigin = canSeeDetail(actor);
    return {
      actions: page.rows.map((row) => actionView(row, showsOrigin)),
      totals,
      nextCursor: page.nextCursor,
      showsOrigin,
    };
  }

  // ── C2 ───────────────────────────────────────────────────────────────────────

  async actionDetail(
    actor: PlatformAdminActor,
    rawOrganizationId: unknown,
    rawEventId: unknown,
    context: PlatformRequestContext,
  ): Promise<PlatformActionDetailView> {
    const organizationId = requireId(rawOrganizationId);
    const eventId = requireId(rawEventId);
    const detail = await this.deps.activity.actionDetail(
      organizationId,
      eventId,
      context.correlationId,
    );
    if (!detail) throw new ApiError(404, 'not_found', 'The requested resource was not found');
    const support =
      detail.action.supportSessionId === null
        ? null
        : await this.deps.activity.supportSession(
            detail.action.supportSessionId,
            context.correlationId,
          );
    // Opening before/after values and IPs is itself an act the operator answers for.
    await this.deps.audit.record({
      actor,
      action: 'platform.action_detail_viewed',
      targetType: 'organization',
      targetId: organizationId,
      targetLabel: detail.action.organizationName,
      organizationId,
      after: { eventId, action: detail.action.action },
      reason: null,
      reasonRequired: false,
      request: { ip: context.ip, userAgent: context.userAgent },
      correlationId: context.correlationId,
    });
    return {
      action: actionView(detail.action, true),
      actorRole: support !== null ? 'platform_support' : detail.actorRole,
      supportSession: support
        ? {
            id: support.id,
            adminEmail: support.adminEmail,
            reason: support.reason,
            startedAt: support.startedAt.toISOString(),
          }
        : null,
      metadata: metadataView(detail.metadataJson),
      changes: detail.changes.map((change) => ({
        field: change.field,
        before: change.redacted ? null : change.before,
        after: change.redacted ? null : change.after,
        redacted: change.redacted,
      })),
      sameCorrelation: detail.sameCorrelation.map((other) => ({
        id: other.id,
        action: other.action,
        actionLabel: auditActionLabel(other.action),
        result: other.result,
        occurredAt: other.createdAt.toISOString(),
      })),
    };
  }

  // ── C3 ───────────────────────────────────────────────────────────────────────

  async signIns(
    actor: PlatformAdminActor,
    query: Record<string, unknown>,
    context: PlatformRequestContext,
  ): Promise<PlatformSignInsPageView> {
    const filter = parseSignInFilter(query);
    const limit = pageSize(query['limit']);
    const rows = await this.deps.activity.listSignIns(
      filter,
      decodeCursor(query['cursor']),
      limit,
      context.correlationId,
    );
    const page = pageOf(rows, limit, (row) => ({ at: row.occurredAt, id: row.id }));
    const showOrigin = canSeeDetail(actor);
    return {
      signIns: page.rows.map((row) => signInView(row, showOrigin)),
      nextCursor: page.nextCursor,
    };
  }

  async sessions(
    actor: PlatformAdminActor,
    query: Record<string, unknown>,
    context: PlatformRequestContext,
  ): Promise<PlatformLiveSessionsPageView> {
    const filter = parseSessionFilter(query);
    const limit = pageSize(query['limit']);
    const rows = await this.deps.activity.listSessions(
      filter,
      decodeCursor(query['cursor']),
      limit,
      context.correlationId,
    );
    const page = pageOf(rows, limit, (row) => ({ at: row.createdAt, id: row.id }));
    const showOrigin = canSeeDetail(actor);
    return {
      sessions: page.rows.map((row) => this.sessionView(row, showOrigin)),
      nextCursor: page.nextCursor,
    };
  }

  private sessionView(row: SessionRow, showOrigin: boolean): PlatformLiveSessionView {
    return {
      id: row.id,
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      isPlatformAdmin: row.platformAdmin || isPlatformAdminEmail(this.deps.allowlist, row.email),
      userAgent: row.userAgent,
      ipFirst: showOrigin ? row.ipFirst : null,
      ipLast: showOrigin ? row.ipLast : null,
      createdAt: row.createdAt.toISOString(),
      lastActiveAt: row.lastActiveAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      active: row.active,
    };
  }

  /** End one session platform-wide. Reason required (SPEC P6, "end session"). */
  async endSession(
    actor: PlatformAdminActor,
    rawSessionId: unknown,
    body: { readonly reason?: unknown },
    context: PlatformRequestContext,
  ): Promise<PlatformSessionEndedView> {
    const sessionId = requireId(rawSessionId);
    const reason = requireReason(body?.reason);
    const outcome = await this.deps.activity.endSession(sessionId, (owner) =>
      platformAuditFor(actor, context, {
        action: 'platform.session_ended',
        targetType: 'user',
        targetId: owner.userId === '' ? null : owner.userId,
        targetLabel: owner.email === '' ? null : owner.email,
        reason,
        afterJson: JSON.stringify({ sessionId, device: owner.userAgent }),
      }),
    );
    if (!outcome || !outcome.ended) {
      throw new ApiError(404, 'not_found', 'The requested resource was not found');
    }
    return { ended: true, userId: outcome.userId };
  }

  async stepUps(
    actor: PlatformAdminActor,
    query: Record<string, unknown>,
    context: PlatformRequestContext,
  ): Promise<PlatformStepUpsPageView> {
    const kind = optionalText(query['kind'], 'kind');
    const limit = pageSize(query['limit']);
    const rows = await this.deps.activity.listStepUps(
      {
        userId: optionalId(query['userId'], 'userId'),
        kind: kind === 'platform' || kind === 'member' ? kind : null,
      },
      decodeCursor(query['cursor']),
      limit,
      context.correlationId,
    );
    const page = pageOf(rows, limit, (row) => ({ at: row.occurredAt, id: row.id }));
    const showOrigin = canSeeDetail(actor);
    return {
      stepUps: page.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        userId: row.userId,
        email: row.email,
        displayName: row.displayName,
        outcome: row.outcome,
        mfaVerified: row.mfaVerified,
        ip: showOrigin ? row.ip : null,
        userAgent: showOrigin ? row.userAgent : null,
        occurredAt: row.occurredAt.toISOString(),
        expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async suspicious(
    query: Record<string, unknown>,
    context: PlatformRequestContext,
  ): Promise<PlatformSuspiciousView> {
    const window = parseWindow(query['window']);
    const rows = await this.deps.activity.listFailures(
      windowStart(window, this.now()),
      context.correlationId,
    );
    return detectSuspicious(rows, window);
  }

  // ── C4 ───────────────────────────────────────────────────────────────────────

  async platformActions(
    actor: PlatformAdminActor,
    query: Record<string, unknown>,
    context: PlatformRequestContext,
  ): Promise<PlatformAdminActionsPageView> {
    const filter = parsePlatformActionFilter(query);
    const limit = pageSize(query['limit']);
    const { rows, total } = await this.deps.activity.listPlatformActions(
      filter,
      decodeCursor(query['cursor']),
      limit,
      context.correlationId,
    );
    const page = pageOf(rows, limit, (row) => ({ at: row.createdAt, id: row.id }));
    const names = await this.deps.activity.organizationNames(
      page.rows.flatMap((row) => (row.organizationId ? [row.organizationId] : [])),
      context.correlationId,
    );
    const detail = canSeeDetail(actor);
    return {
      actions: page.rows.map((row): PlatformAdminActionView => ({
        id: row.id,
        actorUserId: row.actorUserId,
        actorEmail: row.actorEmail,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        targetLabel: row.targetLabel,
        organizationId: row.organizationId,
        organizationName: row.organizationId ? (names.get(row.organizationId) ?? null) : null,
        reason: row.reason,
        supportSessionId: row.supportSessionId,
        correlationId: row.correlationId,
        beforeJson: detail ? row.beforeJson : null,
        afterJson: detail ? row.afterJson : null,
        ip: detail ? row.ip : null,
        userAgent: detail ? row.userAgent : null,
        occurredAt: row.createdAt.toISOString(),
      })),
      total,
      nextCursor: page.nextCursor,
    };
  }

  // ── C5 ───────────────────────────────────────────────────────────────────────

  async supportSessions(
    query: Record<string, unknown>,
    context: PlatformRequestContext,
  ): Promise<PlatformActivitySupportSessionsView> {
    const rows = await this.deps.supportSessions.list(
      {
        state: query['state'] === 'open' ? 'open' : 'all',
        adminUserId: optionalId(query['adminId'], 'adminId'),
        organizationId: optionalId(query['organizationId'], 'organizationId'),
        limit: SUPPORT_LIST_LIMIT,
      },
      context.correlationId,
    );
    const sessions = rows.map(supportSessionView);
    // Open first (soonest to end on top), then the history newest first.
    const ordered = [
      ...sessions
        .filter((session) => session.live)
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)),
      ...sessions.filter((session) => !session.live),
    ];
    return { sessions: ordered, openCount: ordered.filter((session) => session.live).length };
  }

  // ── C6 ───────────────────────────────────────────────────────────────────────

  async createExport(
    actor: PlatformAdminActor,
    body: { readonly scope?: unknown; readonly filter?: unknown; readonly reason?: unknown },
    context: PlatformRequestContext,
  ): Promise<PlatformExportJobView> {
    const scope = requireScope(body?.scope);
    const filter = normalizeFilter(scope, body?.filter);
    const reason = optionalReason(body?.reason);
    const id = uuidv7();
    const job = await this.deps.exports.create({
      id,
      requestedBy: actor.account.userId,
      scope,
      filterJson: JSON.stringify(filter),
      audit: platformAuditFor(actor, context, {
        action: 'platform.export_requested',
        targetType: 'export',
        targetId: id,
        targetLabel: scope,
        reason,
        afterJson: JSON.stringify({ scope, filter }),
      }),
    });
    if (scope !== 'sign-ins') return exportJobView(job);
    // The security log never reaches the worker: the API writes this file now.
    await this.writeSignInsExport(actor, id, filter, context);
    const finished = await this.deps.exports.find(id, context.correlationId);
    return exportJobView(finished ?? job);
  }

  private async writeSignInsExport(
    actor: PlatformAdminActor,
    id: string,
    filter: Readonly<Record<string, string>>,
    context: PlatformRequestContext,
  ): Promise<void> {
    try {
      if (this.deps.objectStore === null) throw new Error('No file storage is set up.');
      const parsed = parseSignInFilter(filter);
      const rows: SignInRow[] = [];
      let cursor = null as ReturnType<typeof decodeCursor>;
      for (;;) {
        const batch = await this.deps.activity.listSignIns(
          parsed,
          cursor,
          1000,
          context.correlationId,
        );
        const page = pageOf(batch, 1000, (row) => ({ at: row.occurredAt, id: row.id }));
        rows.push(...page.rows);
        if (rows.length > EXPORT_ROW_CAP) {
          throw new Error(`Over ${EXPORT_ROW_CAP.toLocaleString('en')} rows. Narrow the filter.`);
        }
        if (page.nextCursor === null) break;
        cursor = decodeCursor(page.nextCursor);
      }
      const bytes = Buffer.from(
        signInsToCsv(rows.map((row) => signInView(row, canSeeDetail(actor)))),
        'utf8',
      );
      const objectKey = exportObjectKey(id);
      const promotion = await this.deps.objectStore.promote({ objectKey, sizeBytes: bytes.length });
      try {
        await new Promise<void>((resolve, reject) => {
          promotion.sink.write(bytes, (error) => (error ? reject(error) : resolve()));
        });
        await promotion.commit();
      } catch (error) {
        await promotion.abort();
        throw error;
      }
      await this.deps.exports.finishReady(id, rows.length, objectKey, context.correlationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The export failed.';
      await this.deps.exports.finishFailed(id, message, context.correlationId);
    }
  }

  async listExports(context: PlatformRequestContext): Promise<PlatformExportJobsView> {
    const jobs = await this.deps.exports.list(EXPORT_LIST_LIMIT, context.correlationId);
    return { exports: jobs.map(exportJobView) };
  }

  async download(rawJobId: unknown, context: PlatformRequestContext): Promise<ExportDownload> {
    const id = requireId(rawJobId);
    const job = await this.deps.exports.find(id, context.correlationId);
    if (!job) throw new ApiError(404, 'not_found', 'The requested resource was not found');
    const view = exportJobView(job);
    if (view.status === 'expired') {
      throw new ApiError(404, 'not_found', 'This export has expired. Run it again.');
    }
    if (view.status !== 'ready' || job.objectKey === null || this.deps.objectStore === null) {
      throw new ApiError(409, 'conflict', 'This export is not ready yet.');
    }
    try {
      const opened = await this.deps.objectStore.openObject({
        zone: 'private',
        objectKey: job.objectKey,
      });
      return { fileName: exportFileName(view), sizeBytes: opened.sizeBytes, stream: opened.stream };
    } catch {
      throw new ApiError(404, 'not_found', 'The requested resource was not found');
    }
  }

  async deleteExport(
    actor: PlatformAdminActor,
    rawJobId: unknown,
    body: { readonly reason?: unknown },
    context: PlatformRequestContext,
  ): Promise<{ readonly deleted: true }> {
    const id = requireId(rawJobId);
    const reason = optionalReason(body?.reason);
    const job = await this.deps.exports.find(id, context.correlationId);
    if (!job) throw new ApiError(404, 'not_found', 'The requested resource was not found');
    const done = await this.deps.exports.markDeleted(
      id,
      platformAuditFor(actor, context, {
        action: 'platform.export_deleted',
        targetType: 'export',
        targetId: id,
        targetLabel: job.scope,
        reason,
        beforeJson: JSON.stringify({ status: job.status, rowCount: job.rowCount }),
      }),
    );
    if (!done) throw new ApiError(404, 'not_found', 'The requested resource was not found');
    return { deleted: true };
  }
}

export function exportJobView(job: ExportJobRecord): PlatformExportJobView {
  return {
    id: job.id,
    scope: job.scope as PlatformExportScope,
    filter: parseFilterJson(job.filterJson),
    status: viewStatus(job.status, job.expiresAt, job.now),
    requestedByUserId: job.requestedBy,
    requestedByEmail: job.requestedByEmail,
    requestedByName: job.requestedByName,
    rowCount: job.rowCount,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    expiresAt: job.expiresAt ? job.expiresAt.toISOString() : null,
  };
}
