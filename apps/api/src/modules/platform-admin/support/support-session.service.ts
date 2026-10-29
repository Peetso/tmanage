import { auditActionLabel, uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { AuditService } from '../../audit/audit.service.js';
import { optionalReason, requireId, requireReason } from '../platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin.access.js';
import { actorHas } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import {
  SUPPORT_DEFAULT_MINUTES,
  SUPPORT_EXTEND_MINUTES,
  extendedExpiry,
  parseSupportMinutes,
  planEntry,
  planExit,
  requireLiveStepUp,
  supportSessionLive,
} from './hidden-membership.js';
import type { SupportEndReason } from './hidden-membership.js';
import { SupportSessionsRepository } from './support-sessions.repository.js';
import type {
  SupportSessionListRecord,
  SupportSessionRecord,
} from './support-sessions.repository.js';

/**
 * Support mode (platform-admin v2 · PA-05, SPEC P3, §3.2, §8).
 *
 * A platform admin enters ONE organization for a limited time through a real, hidden membership
 * with the internal role `platform_support`. Every existing isolation layer applies unchanged:
 * the row is a tenant row, the context it resolves to is bound to that one organization, and
 * PA-01's resolver refuses the row the moment its session is no longer live.
 *
 * Every change of state — enter, extend, exit, expiry — is ONE transaction on the tenant path of
 * that organization: the session row, the membership row, `organizations.policy_version` (which
 * kills every cached context, SPEC §3.2), the platform audit row and the organization's own audit
 * row (`support.session_*`, which the owners read in their audit log — the disclosure).
 */

/** `POST /v1/platform/organizations/:id/support-session` → where the browser goes next. */
export interface StartSupportSessionView {
  readonly id: string;
  readonly slug: string;
  readonly expiresAt: string;
  readonly redirectTo: string;
}

/** One support session as the platform screens show it (C5, the banner, the exit dialog). */
export interface PlatformSupportSessionView {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly adminUserId: string;
  readonly adminEmail: string;
  readonly reason: string | null;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  readonly endedReason: string | null;
  readonly actionsCount: number;
  readonly live: boolean;
}

/** `GET /v1/platform/support-sessions` */
export interface PlatformSupportSessionsView {
  readonly sessions: readonly PlatformSupportSessionView[];
}

/** `GET /v1/platform/support-sessions/:id` — with the last actions for the exit dialog. */
export interface PlatformSupportSessionDetailView {
  readonly session: PlatformSupportSessionView;
  /** Plain-English labels of the newest actions (at most {@link RECENT_ACTIONS}). */
  readonly recentActions: readonly string[];
}

/** `GET /v1/organizations/:orgSlug/support-session` — the banner's facts, or null. */
export interface OrganizationSupportSessionView {
  readonly id: string;
  readonly expiresAt: string;
  readonly adminEmail: string;
  readonly startedAt: string;
  readonly actionsCount: number;
}

export const RECENT_ACTIONS = 3;
const LIST_LIMIT = 200;

type Clock = () => Date;

export class SupportSessionService {
  private readonly repository: SupportSessionsRepository;
  private readonly orgAudit: AuditService;

  constructor(
    private readonly database: TenantDatabase,
    private readonly platformAudit: PlatformAuditService,
    private readonly now: Clock = () => new Date(),
    repository?: SupportSessionsRepository,
    orgAudit?: AuditService,
  ) {
    this.repository = repository ?? new SupportSessionsRepository(database);
    this.orgAudit = orgAudit ?? new AuditService(database);
  }

  // ── Enter ────────────────────────────────────────────────────────────────────────────────────

  async start(
    actor: PlatformAdminActor,
    rawOrganizationId: unknown,
    body: { readonly minutes?: unknown; readonly reason?: unknown },
    request: PlatformRequestContext,
  ): Promise<StartSupportSessionView> {
    const organizationId = requireId(rawOrganizationId);
    const minutes = parseSupportMinutes(body?.minutes, SUPPORT_DEFAULT_MINUTES);
    const reason = optionalReason(body?.reason);
    requireLiveStepUp(actor.stepUp, this.now());

    const adminUserId = actor.account.userId;
    const context = serviceContext(organizationId, request.correlationId);
    return this.database.transaction(context, async (tx) => {
      const organization = await this.repository.lockOrganization(tx, organizationId);
      if (!organization) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      if (organization.suspended) {
        throw new ApiError(
          409,
          'conflict',
          'This organization is suspended. Reactivate it before entering.',
          undefined,
          'support_session_suspended',
        );
      }
      const redirectTo = `/${organization.slug}/home`;

      // Already inside: hand back the visit that is running rather than stacking a second one.
      const running = await this.repository.liveFor(tx, adminUserId, organizationId);
      if (running) {
        // Entered again from a different sign-in (the earlier browser session was never signed
        // out): the visit follows the admin to this browser session, or the banner read would end
        // it as signed out and leave this browser inside the organization without a banner.
        if (running.browserSessionId !== actor.sessionId) {
          await this.repository.rebindBrowserSession(tx, running.id, actor.sessionId);
          await this.platformAudit.insert(
            tx,
            this.platformAudit.build({
              actor,
              action: 'platform.support_session_started',
              targetType: 'support_session',
              targetId: running.id,
              targetLabel: organization.name,
              organizationId,
              supportSessionId: running.id,
              before: { browserSession: 'previous' },
              after: { browserSession: 'current', expiresAt: running.expiresAt.toISOString() },
              reason,
              reasonRequired: false,
              request,
              correlationId: request.correlationId,
            }),
          );
        }
        return {
          id: running.id,
          slug: organization.slug,
          expiresAt: running.expiresAt.toISOString(),
          redirectTo,
        };
      }

      const existing = await this.repository.membershipFor(tx, organizationId, adminUserId);
      const plan = planEntry(existing);
      const sessionId = await this.repository.insertSession(tx, {
        adminUserId,
        browserSessionId: actor.sessionId,
        organizationId,
        reason,
        minutes,
      });
      let membershipId: string;
      if (plan.kind === 'insert') {
        membershipId = await this.repository.insertHiddenMembership(
          tx,
          organizationId,
          adminUserId,
          sessionId,
        );
        await this.repository.linkSession(tx, sessionId, membershipId, null, null);
      } else {
        membershipId = plan.membershipId;
        await this.repository.enterMembership(tx, organizationId, membershipId, sessionId);
        await this.repository.linkSession(
          tx,
          sessionId,
          membershipId,
          plan.kind === 'upgrade' ? plan.previousRole : null,
          plan.kind === 'upgrade' ? plan.previousHasOrgWideScope : null,
        );
      }
      await this.repository.bumpOrganization(tx, organizationId);

      const locked = await this.repository.lockSession(tx, sessionId);
      const expiresAt =
        locked?.session.expiresAt ?? new Date(this.now().getTime() + minutes * 60_000);

      await this.platformAudit.insert(
        tx,
        this.platformAudit.build({
          actor,
          action: 'platform.support_session_started',
          targetType: 'support_session',
          targetId: sessionId,
          targetLabel: organization.name,
          organizationId,
          supportSessionId: sessionId,
          after: {
            minutes,
            expiresAt: expiresAt.toISOString(),
            membership: plan.kind,
          },
          reason,
          reasonRequired: false,
          request,
          correlationId: request.correlationId,
        }),
      );
      await this.recordOrgAudit(tx, context, 'support.session_started', sessionId, adminUserId, {
        platform_support_session_id: sessionId,
        minutes,
        upgraded_own_membership: plan.kind === 'upgrade',
      });

      return {
        id: sessionId,
        slug: organization.slug,
        expiresAt: expiresAt.toISOString(),
        redirectTo,
      };
    });
  }

  // ── Extend ───────────────────────────────────────────────────────────────────────────────────

  async extend(
    actor: PlatformAdminActor,
    rawSessionId: unknown,
    body: { readonly minutes?: unknown },
    request: PlatformRequestContext,
  ): Promise<PlatformSupportSessionDetailView> {
    const sessionId = requireId(rawSessionId);
    const minutes = parseSupportMinutes(body?.minutes, SUPPORT_EXTEND_MINUTES);
    requireLiveStepUp(actor.stepUp, this.now());
    const record = await this.requireSession(sessionId, request.correlationId);
    if (record.adminUserId !== actor.account.userId) throw notFound();

    const context = serviceContext(record.organizationId, request.correlationId);
    await this.database.transaction(context, async (tx) => {
      const locked = await this.repository.lockSession(tx, sessionId);
      if (!locked) throw notFound();
      const { session, now } = locked;
      if (!supportSessionLive(session, now)) throw sessionEnded();
      const expiresAt = extendedExpiry(session.startedAt, session.expiresAt, now, minutes);
      if (expiresAt.getTime() <= session.expiresAt.getTime()) {
        throw new ApiError(
          409,
          'conflict',
          'This session has reached its 8-hour limit. Exit and start a new one.',
          undefined,
          'support_session_cap',
        );
      }
      await this.repository.extendSession(tx, sessionId, expiresAt);
      await this.platformAudit.insert(
        tx,
        this.platformAudit.build({
          actor,
          action: 'platform.support_session_extended',
          targetType: 'support_session',
          targetId: sessionId,
          targetLabel: record.organizationName,
          organizationId: record.organizationId,
          supportSessionId: sessionId,
          before: { expiresAt: session.expiresAt.toISOString() },
          after: { expiresAt: expiresAt.toISOString() },
          reason: undefined,
          reasonRequired: false,
          request,
          correlationId: request.correlationId,
        }),
      );
    });
    return this.detail(actor, sessionId, request);
  }

  // ── Exit ─────────────────────────────────────────────────────────────────────────────────────

  /**
   * `DELETE /v1/platform/support-sessions/:id`. The admin's own Exit needs no reason; ending
   * ANOTHER admin's session is on the destructive list (SPEC P6, "end session") and needs one,
   * plus `platform.orgs.lifecycle`.
   */
  async end(
    actor: PlatformAdminActor,
    rawSessionId: unknown,
    body: { readonly reason?: unknown },
    request: PlatformRequestContext,
  ): Promise<PlatformSupportSessionDetailView> {
    const sessionId = requireId(rawSessionId);
    const record = await this.requireSession(sessionId, request.correlationId);
    const own = record.adminUserId === actor.account.userId;
    if (!own && !actorHas(actor, 'platform.orgs.lifecycle')) throw notFound();
    // The route is step-up exempt so an admin can always leave; ending someone else's is not.
    if (!own && !actor.stepUp) throw stepUpRequired();
    const reason = own ? optionalReason(body?.reason) : requireReason(body?.reason);
    await this.finish(record, own ? 'exited' : 'ended_by_admin', {
      actor,
      reason,
      request,
    });
    return this.detail(actor, sessionId, request);
  }

  /**
   * Sign-out of the browser session a visit is bound to ends it (SPEC §3.2). The identity module
   * calls this through {@link SupportSignOutListener}; when nothing calls it, the next banner read
   * from another browser session and the minute sweeper both still end it.
   */
  async endForBrowserSession(
    adminUserId: string,
    browserSessionId: string,
    correlationId: string,
  ): Promise<number> {
    const open = await this.repository.openForBrowserSession(
      adminUserId,
      browserSessionId,
      correlationId,
    );
    let ended = 0;
    for (const row of open) {
      const record = await this.repository.findById(row.id, correlationId);
      if (record && (await this.finish(record, 'signed_out', { correlationId }))) ended += 1;
    }
    return ended;
  }

  /**
   * End one session in one transaction: the row, the membership (offboard the hidden row or put
   * the admin's own row back), the policy bump and both audit rows. Returns false when it had
   * already ended (idempotent: a second Exit, or the sweeper first).
   */
  async finish(
    record: SupportSessionRecord,
    endReason: SupportEndReason,
    by: {
      readonly actor?: PlatformAdminActor;
      readonly reason?: string | null;
      readonly request?: PlatformRequestContext;
      readonly correlationId?: string;
    },
  ): Promise<boolean> {
    const correlationId = by.request?.correlationId ?? by.correlationId ?? uuidv7();
    const context = serviceContext(record.organizationId, correlationId);
    return this.database.transaction(context, async (tx) => {
      const locked = await this.repository.lockSession(tx, record.id);
      if (!locked || locked.session.endedAt !== null) return false;
      const session = locked.session;
      if (!(await this.repository.endSession(tx, session.id, endReason))) return false;
      await this.leaveMembership(tx, session);
      await this.repository.bumpOrganization(tx, session.organizationId);

      const adminEmail = (await this.repository.adminEmail(tx, session.adminUserId)) ?? '';
      const audit = {
        action: 'platform.support_session_ended',
        targetType: 'support_session' as const,
        targetId: session.id,
        targetLabel: null,
        organizationId: session.organizationId,
        supportSessionId: session.id,
        before: { expiresAt: session.expiresAt.toISOString() },
        after: { endedReason: endReason, actionsCount: session.actionsCount },
      };
      if (by.actor && by.request) {
        await this.platformAudit.insert(
          tx,
          this.platformAudit.build({
            ...audit,
            actor: by.actor,
            reason: by.reason ?? undefined,
            reasonRequired: false,
            request: by.request,
            correlationId,
          }),
        );
      } else {
        // Sign-out: the admin is the actor; the request facts are gone with the session.
        await this.platformAudit.insert(tx, {
          ...audit,
          actorUserId: session.adminUserId,
          actorEmail: adminEmail,
          reason: null,
          correlationId,
          beforeJson: JSON.stringify(audit.before),
          afterJson: JSON.stringify(audit.after),
          ip: null,
          userAgent: null,
        });
      }
      await this.recordOrgAudit(
        tx,
        context,
        'support.session_ended',
        session.id,
        by.actor?.account.userId ?? session.adminUserId,
        {
          platform_support_session_id: session.id,
          end_cause: endReason,
          actions_count: session.actionsCount,
        },
        session.adminUserId,
      );
      return true;
    });
  }

  private async leaveMembership(tx: TenantQueryRunner, session: SupportSessionRecord) {
    const plan = planExit(session);
    if (plan.kind === 'offboard') {
      await this.repository.offboardMembership(
        tx,
        session.organizationId,
        plan.membershipId,
        session.id,
      );
    } else if (plan.kind === 'restore') {
      await this.repository.restoreMembership(tx, {
        organizationId: session.organizationId,
        membershipId: plan.membershipId,
        sessionId: session.id,
        role: plan.role,
        status: plan.status,
        hasOrgWideScope: plan.hasOrgWideScope,
      });
    }
  }

  // ── Reads ────────────────────────────────────────────────────────────────────────────────────

  async list(
    query: {
      readonly open?: unknown;
      readonly all?: unknown;
      readonly state?: unknown;
      readonly adminId?: unknown;
      readonly organizationId?: unknown;
    },
    request: PlatformRequestContext,
  ): Promise<PlatformSupportSessionsView> {
    const wantsAll = query.all !== undefined || query.state === 'all';
    const rows = await this.repository.list(
      {
        state: wantsAll ? 'all' : 'open',
        adminUserId: query.adminId === undefined ? null : requireId(query.adminId),
        organizationId: query.organizationId === undefined ? null : requireId(query.organizationId),
        limit: LIST_LIMIT,
      },
      request.correlationId,
    );
    return { sessions: rows.map(toView) };
  }

  /**
   * One session with its newest actions. The admin's own session is readable without a fresh
   * step-up (the banner polls it); anyone else's needs `platform.activity.view` and a step-up.
   */
  async detail(
    actor: PlatformAdminActor,
    rawSessionId: unknown,
    request: PlatformRequestContext,
  ): Promise<PlatformSupportSessionDetailView> {
    const sessionId = requireId(rawSessionId);
    const record = await this.requireSession(sessionId, request.correlationId);
    if (record.adminUserId !== actor.account.userId) {
      if (!actorHas(actor, 'platform.activity.view')) throw notFound();
      if (!actor.stepUp) throw stepUpRequired();
    }
    const context = serviceContext(record.organizationId, request.correlationId);
    const actions = await this.database.read(context, (runner) =>
      this.repository.recentActions(runner, record.organizationId, sessionId, RECENT_ACTIONS),
    );
    return { session: toView(record), recentActions: actions.map(auditActionLabel) };
  }

  /**
   * The banner's facts for the member's own live session in this organization (tenant path). A
   * session bound to another browser session is a signed-out one: it is ended here, and the
   * caller sees none.
   */
  async forMember(
    supportSession: { readonly id: string; readonly adminUserId: string } | null,
    browserSessionId: string | null,
    correlationId: string,
  ): Promise<OrganizationSupportSessionView | null> {
    if (supportSession === null) return null;
    const record = await this.repository.findById(supportSession.id, correlationId);
    if (!record || !supportSessionLive(record, record.now)) return null;
    if (browserSessionId !== null && record.browserSessionId !== browserSessionId) {
      await this.finish(record, 'signed_out', { correlationId });
      return null;
    }
    return {
      id: record.id,
      expiresAt: record.expiresAt.toISOString(),
      adminEmail: record.adminEmail,
      startedAt: record.startedAt.toISOString(),
      actionsCount: record.actionsCount,
    };
  }

  private async requireSession(
    sessionId: string,
    correlationId: string,
  ): Promise<SupportSessionListRecord> {
    const record = await this.repository.findById(sessionId, correlationId);
    if (!record) throw notFound();
    return record;
  }

  private async recordOrgAudit(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: 'support.session_started' | 'support.session_ended',
    sessionId: string,
    actorUserId: string,
    metadata: Record<string, string | number | boolean>,
    effectiveActorId: string = actorUserId,
  ): Promise<void> {
    await this.orgAudit.record(tx, context, {
      action,
      result: 'allowed',
      objectId: sessionId,
      actorUserId,
      effectiveActorId,
      metadata,
    });
  }
}

/** The one-organization service context every write here runs under. */
function serviceContext(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({ organizationId, correlationId, policyVersion: 'support-session' });
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

function stepUpRequired(): ApiError {
  return new ApiError(
    403,
    'reauthentication_required',
    'Confirm your password to open Platform admin.',
    undefined,
    'platform_admin_step_up_required',
  );
}

function sessionEnded(): ApiError {
  return new ApiError(
    409,
    'conflict',
    'This Support session has already ended.',
    undefined,
    'support_session_ended',
  );
}

export function toView(record: SupportSessionListRecord): PlatformSupportSessionView {
  return {
    id: record.id,
    organizationId: record.organizationId,
    organizationName: record.organizationName,
    organizationSlug: record.organizationSlug,
    adminUserId: record.adminUserId,
    adminEmail: record.adminEmail,
    reason: record.reason,
    startedAt: record.startedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    endedAt: record.endedAt ? record.endedAt.toISOString() : null,
    endedReason: record.endedReason,
    actionsCount: record.actionsCount,
    live: supportSessionLive(record, record.now),
  };
}

/**
 * The seam the identity module's sign-out calls (PA-06 owns those files this wave). Registered by
 * the support module at boot; a no-op until then.
 */
export interface SupportSignOutListener {
  browserSessionEnded(
    userId: string,
    browserSessionId: string,
    correlationId: string,
  ): Promise<void>;
}

let signOutListener: SupportSignOutListener | null = null;

export function registerSupportSignOutListener(listener: SupportSignOutListener | null): void {
  signOutListener = listener;
}

/** Called by the sign-out path. Never throws: signing out must not fail on a support cleanup. */
export async function notifyBrowserSessionEnded(
  userId: string,
  browserSessionId: string,
  correlationId: string,
): Promise<void> {
  try {
    await signOutListener?.browserSessionEnded(userId, browserSessionId, correlationId);
  } catch {
    // The minute sweeper and the next banner read end it instead.
  }
}
