import { PLATFORM_PERMISSIONS } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { AuthenticationRejectedError } from '../identity/authentication.service.js';
import { PLATFORM_STEP_UP_MINUTES } from './platform-admin.access.js';
import type { PlatformRequestContext } from './platform-admin.access.js';
import type { PlatformAdminActor } from './platform-admin.guard.js';
import type { PlatformAdminRepository } from './platform-admin.repository.js';
import { platformAuditFor } from './platform-audit.service.js';

/**
 * Platform admin — the session part: who the operator is (`me`) and the step-up.
 *
 * Platform admin v2 split the rest by area (`platform-admin.areas.ts`): organizations, people,
 * settings, activity and the team each have their own controller, service and module. The view
 * types stay here so the web contract (`e2e/contracts/api-web-shapes.ts`) keeps one import.
 */

export type RequestContext = PlatformRequestContext;

/**
 * The slice of `AuthenticationService` the step-up needs: password (+ code) re-confirmation, and
 * whether that re-confirmation will want an authenticator code (STEPUPFIX: one rule for both).
 */
export interface Reauthenticator {
  confirmReauthentication(input: {
    userId: string;
    sessionId: string;
    password: string;
    code?: string | undefined;
    context: RequestContext;
  }): Promise<unknown>;
  reauthenticationNeedsAuthenticatorCode(input: {
    userId: string;
    correlationId: string;
  }): Promise<boolean>;
}

/** The slice of `PasswordResetService` the reset action needs. */
export interface ResetMailer {
  request(email: unknown, context: RequestContext): Promise<unknown>;
}

export interface PlatformMeView {
  readonly email: string;
  readonly displayName: string;
  readonly mfaEnabled: boolean;
  /**
   * STEPUPFIX. Whether the step-up asks for the 6-digit authenticator code next to the password.
   * False when two-step is by e-mail codes only: the sign-in already passed that second step and
   * no code is mailed for a step-up. Computed by the rule `confirmReauthentication` enforces.
   */
  readonly stepUpNeedsAuthenticatorCode: boolean;
  readonly stepUpExpiresAt: string | null;
  readonly stepUpMinutes: number;
  // ---- platform-admin v2 · PA-02 ----
  /** `env` = on `PLATFORM_ADMIN_EMAILS` (bootstrap super admin); `db` = added in Team. */
  readonly source: 'env' | 'db';
  readonly preset: 'super_admin' | 'support' | 'auditor' | 'custom';
  /** Every platform permission this admin holds (SPEC §3.1 keys). */
  readonly permissions: readonly string[];
  /** The admin's live Support sessions (PA-03 opens them; empty until then). */
  readonly supportSessions: readonly PlatformMeSupportSessionView[];
}

export interface PlatformMeSupportSessionView {
  readonly id: string;
  readonly organizationId: string;
  readonly slug: string | null;
  readonly expiresAt: string;
}

export interface PlatformCompanyView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly ownerEmail: string | null;
  readonly people: number;
  readonly clients: number;
  readonly projects: number;
  readonly plan: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string | null;
  readonly status: 'active' | 'suspended' | 'archived';
  readonly suspendedAt: string | null;
}

export interface PlatformOverviewView {
  readonly companies: number;
  readonly suspendedCompanies: number;
  readonly people: number;
  readonly signups7d: number;
  readonly signups30d: number;
  readonly activeToday: number;
  readonly storageBytesUsed: number;
  readonly failedAutomationRuns7d: number;
  readonly outboxErrors: number;
  readonly computedAt: string;
}

export interface PlatformCompanyAuditView {
  readonly id: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly occurredAt: string;
}

export interface PlatformCompanyDetailView {
  readonly company: PlatformCompanyView;
  readonly recentAdminEvents: readonly PlatformCompanyAuditView[];
}

export interface PlatformPersonView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
  readonly mfaEnabled: boolean;
  readonly companies: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly audience: 'internal' | 'client';
    readonly role: string;
    readonly status: string;
  }[];
}

export interface PlatformSettingsView {
  readonly publicSignup: {
    readonly open: boolean;
    readonly source: 'environment' | 'platform_setting';
    readonly environmentDefault: boolean;
  };
  /**
   * The platform AI kill switch (MCP connector S11): when off, `/mcp` and the OAuth endpoints
   * answer 503 for every company. `TMANAGE_MCP_DISABLED=1` forces it off whatever is stored.
   */
  readonly aiAccess: {
    readonly on: boolean;
    readonly environmentDisabled: boolean;
  };
}

export interface PlatformAuditEventView {
  readonly id: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  /** `null` since 0239: a reason is optional on reads and edits (SPEC P6). */
  readonly reason: string | null;
  readonly occurredAt: string;
}

export class PlatformAdminService {
  constructor(
    private readonly repository: PlatformAdminRepository,
    private readonly reauth: Reauthenticator,
  ) {}

  async me(actor: PlatformAdminActor, context: RequestContext): Promise<PlatformMeView> {
    const [sessions, stepUpNeedsAuthenticatorCode] = await Promise.all([
      this.repository.admins.liveSupportSessions(actor.account.userId, context.correlationId),
      this.reauth.reauthenticationNeedsAuthenticatorCode({
        userId: actor.account.userId,
        correlationId: context.correlationId,
      }),
    ]);
    const slugs = await this.repository.organizationSlugs(
      [...new Set(sessions.map((session) => session.organizationId))],
      context.correlationId,
    );
    return {
      email: actor.account.email,
      displayName: actor.account.displayName,
      mfaEnabled: actor.account.mfaEnabled,
      stepUpNeedsAuthenticatorCode,
      stepUpExpiresAt: actor.stepUp ? actor.stepUp.expiresAt.toISOString() : null,
      stepUpMinutes: PLATFORM_STEP_UP_MINUTES,
      source: actor.source ?? 'env',
      preset: actor.preset ?? 'super_admin',
      permissions: [...(actor.permissions ?? PLATFORM_PERMISSIONS)],
      supportSessions: sessions.map((session) => ({
        id: session.id,
        organizationId: session.organizationId,
        slug: slugs.get(session.organizationId) ?? null,
        expiresAt: session.expiresAt.toISOString(),
      })),
    };
  }

  /**
   * Confirm the password — and the authenticator code, when one is set up: `confirmReauthentication`
   * refuses a password alone for an account with an authenticator factor (e-mail codes only: the
   * password is enough, STEPUPFIX) — then open a 15-minute window
   * bound to this session. A wrong password is the caller's 401, rate-limited by the same
   * control sign-in uses.
   */
  async stepUp(
    actor: PlatformAdminActor,
    body: { readonly password?: unknown; readonly code?: unknown },
    context: RequestContext,
  ): Promise<{ readonly expiresAt: string; readonly mfaVerified: boolean }> {
    const password = typeof body?.password === 'string' ? body.password : '';
    if (password === '') {
      throw new ApiError(400, 'validation_failed', 'Enter your password.', [
        { field: 'password', message: 'required' },
      ]);
    }
    try {
      await this.reauth.confirmReauthentication({
        userId: actor.account.userId,
        sessionId: actor.sessionId,
        password,
        code: typeof body?.code === 'string' && body.code !== '' ? body.code : undefined,
        context,
      });
    } catch (error) {
      if (error instanceof AuthenticationRejectedError)
        await this.auditFailedStepUp(actor, context);
      throw error;
    }
    const expiresAt = await this.repository.recordStepUp({
      userId: actor.account.userId,
      sessionId: actor.sessionId,
      mfaVerified: actor.account.mfaEnabled,
      minutes: PLATFORM_STEP_UP_MINUTES,
      audit: platformAuditFor(actor, context, {
        action: 'platform.step_up',
        targetType: 'platform',
        targetId: null,
        targetLabel: null,
        reason: actor.account.mfaEnabled
          ? 'Confirmed password and two-step code to open Platform admin'
          : 'Confirmed password to open Platform admin (two-step sign-in not set up)',
      }),
    });
    return { expiresAt: expiresAt.toISOString(), mfaVerified: actor.account.mfaEnabled };
  }

  /**
   * R14-d: a refused step-up goes to the platform trail too, so the worker's
   * `platform_step_up_failures` rule counts it without a read on the security log. Best effort:
   * a failed write never replaces the caller's 401 (the security log row is already written).
   */
  private async auditFailedStepUp(
    actor: PlatformAdminActor,
    context: RequestContext,
  ): Promise<void> {
    const audit = platformAuditFor(actor, context, {
      action: 'platform.step_up_failed',
      targetType: 'platform',
      targetId: null,
      targetLabel: null,
      reason: 'Step-up to Platform admin refused (wrong password or two-step code)',
    });
    await this.repository.recordAudit(audit).catch(() => undefined);
  }
}
