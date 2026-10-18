import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PLATFORM_STEP_UP_MINUTES, requireId, requireReason } from './platform-admin.access.js';
import type { PlatformAdminActor } from './platform-admin.guard.js';
import type {
  PlatformAdminRepository,
  PlatformAuditInput,
  PlatformCompanyRow,
} from './platform-admin.repository.js';
import { MAX_PLATFORM_AUDIT } from './platform-admin.repository.js';
import { PUBLIC_SIGNUP_SETTING, publicSignupFromSetting } from './platform-settings.js';

/**
 * Platform admin — the operator's reads and actions. Every action takes a typed reason and
 * writes the platform audit row in the same transaction as the change (or, for the reset
 * email, before the email is composed). Nothing here reads customer content, and there is
 * no impersonation: the operator can stop a company, end a person's sessions and send them
 * the ordinary reset email, and that is all.
 */

export interface RequestContext {
  readonly correlationId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** The slice of `AuthenticationService` the step-up needs: password (+ code) re-confirmation. */
export interface Reauthenticator {
  confirmReauthentication(input: {
    userId: string;
    sessionId: string;
    password: string;
    code?: string | undefined;
    context: RequestContext;
  }): Promise<unknown>;
}

/** The slice of `PasswordResetService` the reset action needs. */
export interface ResetMailer {
  request(email: unknown, context: RequestContext): Promise<unknown>;
}

export interface PlatformMeView {
  readonly email: string;
  readonly displayName: string;
  readonly mfaEnabled: boolean;
  readonly stepUpExpiresAt: string | null;
  readonly stepUpMinutes: number;
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
}

export interface PlatformAuditEventView {
  readonly id: string;
  readonly actorEmail: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly reason: string;
  readonly occurredAt: string;
}

export class PlatformAdminService {
  constructor(
    private readonly repository: PlatformAdminRepository,
    private readonly reauth: Reauthenticator,
    private readonly resets: ResetMailer,
    private readonly publicSignupDefault: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  me(actor: PlatformAdminActor): PlatformMeView {
    return {
      email: actor.account.email,
      displayName: actor.account.displayName,
      mfaEnabled: actor.account.mfaEnabled,
      stepUpExpiresAt: actor.stepUp ? actor.stepUp.expiresAt.toISOString() : null,
      stepUpMinutes: PLATFORM_STEP_UP_MINUTES,
    };
  }

  /**
   * Confirm the password — and the two-step code, when one is set up: `confirmReauthentication`
   * refuses a password alone for an account that has a factor — then open a 15-minute window
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
    await this.reauth.confirmReauthentication({
      userId: actor.account.userId,
      sessionId: actor.sessionId,
      password,
      code: typeof body?.code === 'string' && body.code !== '' ? body.code : undefined,
      context,
    });
    const expiresAt = await this.repository.recordStepUp({
      userId: actor.account.userId,
      sessionId: actor.sessionId,
      mfaVerified: actor.account.mfaEnabled,
      minutes: PLATFORM_STEP_UP_MINUTES,
      audit: this.audit(actor, context, {
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

  async overview(context: RequestContext): Promise<PlatformOverviewView> {
    const row = await this.repository.overview(this.now(), context.correlationId);
    return { ...row, computedAt: this.now().toISOString() };
  }

  async companies(
    rawSearch: unknown,
    context: RequestContext,
  ): Promise<{ readonly companies: readonly PlatformCompanyView[] }> {
    const search = typeof rawSearch === 'string' ? rawSearch.trim().slice(0, 190) : '';
    const rows = await this.repository.listCompanies(
      search === '' ? null : search,
      context.correlationId,
    );
    return { companies: rows.map(toCompanyView) };
  }

  async company(rawId: unknown, context: RequestContext): Promise<PlatformCompanyDetailView> {
    const id = requireId(rawId);
    const row = await this.repository.findCompany(id, context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const events = await this.repository.listCompanyAudit(id, context.correlationId);
    return {
      company: toCompanyView(row),
      recentAdminEvents: events.map((event) => ({
        id: event.id,
        action: event.action,
        objectType: event.objectType,
        result: event.result,
        occurredAt: event.createdAt.toISOString(),
      })),
    };
  }

  async setSuspended(
    actor: PlatformAdminActor,
    rawId: unknown,
    suspend: boolean,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<{ readonly company: PlatformCompanyView }> {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    const row = await this.repository.findCompany(id, context.correlationId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const already = row.suspendedAt !== null;
    if (already === suspend) {
      throw new ApiError(
        409,
        'conflict',
        suspend ? 'This company is already suspended.' : 'This company is not suspended.',
      );
    }
    await this.repository.setSuspended(
      id,
      suspend,
      this.audit(actor, context, {
        action: suspend ? 'platform.company_suspended' : 'platform.company_reactivated',
        targetType: 'organization',
        targetId: id,
        targetLabel: row.name,
        reason,
      }),
    );
    const updated = await this.repository.findCompany(id, context.correlationId);
    return { company: toCompanyView(updated ?? row) };
  }

  async people(
    rawEmail: unknown,
    context: RequestContext,
  ): Promise<{ readonly people: readonly PlatformPersonView[] }> {
    const fragment = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';
    if (fragment.length < 3 || fragment.length > 254) {
      throw new ApiError(400, 'validation_failed', 'Type at least three characters of an email.', [
        { field: 'email', message: '3–254 characters' },
      ]);
    }
    const found = await this.repository.searchPeople(fragment, context.correlationId);
    return {
      people: found.people.map((person) => ({
        id: person.userId,
        email: person.email,
        displayName: person.displayName,
        emailVerified: person.emailVerified,
        createdAt: person.createdAt.toISOString(),
        lastSignInAt: person.lastSignInAt ? person.lastSignInAt.toISOString() : null,
        mfaEnabled: person.mfaEnabled,
        companies: found.memberships
          .filter((membership) => membership.userId === person.userId)
          .map((membership) => ({
            id: membership.organizationId,
            name: membership.organizationName,
            slug: membership.organizationSlug,
            audience: membership.audience,
            role: membership.role,
            status: membership.status,
          })),
      })),
    };
  }

  async signOutEverywhere(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ) {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    const person = await this.repository.findPerson(id, context.correlationId);
    if (!person) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const ended = await this.repository.signOutEverywhere(
      id,
      this.audit(actor, context, {
        action: 'platform.user_signed_out',
        targetType: 'user',
        targetId: id,
        targetLabel: person.email,
        reason,
      }),
    );
    return { sessionsEnded: ended };
  }

  async sendPasswordReset(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ) {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    const person = await this.repository.findPerson(id, context.correlationId);
    if (!person) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    // Audited first: if composing the mail fails, the attempt is still on the record.
    await this.repository.recordAudit(
      this.audit(actor, context, {
        action: 'platform.password_reset_sent',
        targetType: 'user',
        targetId: id,
        targetLabel: person.email,
        reason,
      }),
    );
    // The ordinary self-service reset: a single-use 30-minute link to the person's own
    // address. The operator never sees the link or sets a password.
    await this.resets.request(person.email, context);
    return { status: 'sent' as const };
  }

  async settings(context: RequestContext): Promise<PlatformSettingsView> {
    const stored = await this.repository.readSetting(PUBLIC_SIGNUP_SETTING, context.correlationId);
    return this.settingsView(stored);
  }

  async setPublicSignup(
    actor: PlatformAdminActor,
    body: { readonly open?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformSettingsView> {
    if (typeof body?.open !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'Choose open or closed.', [
        { field: 'open', message: 'must be a boolean' },
      ]);
    }
    const reason = requireReason(body?.reason);
    const value = body.open ? 'open' : 'closed';
    await this.repository.writeSetting(
      PUBLIC_SIGNUP_SETTING,
      value,
      this.audit(actor, context, {
        action: body.open ? 'platform.public_signup_opened' : 'platform.public_signup_closed',
        targetType: 'setting',
        targetId: null,
        targetLabel: PUBLIC_SIGNUP_SETTING,
        reason,
      }),
    );
    return this.settingsView(value);
  }

  async auditLog(
    context: RequestContext,
  ): Promise<{ readonly events: readonly PlatformAuditEventView[] }> {
    const rows = await this.repository.listAudit(MAX_PLATFORM_AUDIT, context.correlationId);
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

  private settingsView(stored: string | null): PlatformSettingsView {
    return {
      publicSignup: {
        open: publicSignupFromSetting(stored, this.publicSignupDefault),
        source: stored === null ? ('environment' as const) : ('platform_setting' as const),
        environmentDefault: this.publicSignupDefault,
      },
    };
  }

  private audit(
    actor: PlatformAdminActor,
    context: RequestContext,
    fields: Omit<PlatformAuditInput, 'actorUserId' | 'actorEmail' | 'correlationId'>,
  ): PlatformAuditInput {
    return {
      actorUserId: actor.account.userId,
      actorEmail: actor.account.email,
      correlationId: context.correlationId,
      ...fields,
    };
  }
}

function toCompanyView(row: PlatformCompanyRow): PlatformCompanyView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerEmail: row.ownerEmail,
    people: row.people,
    clients: row.clients,
    projects: row.projects,
    plan: row.planId,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    status: row.archivedAt ? 'archived' : row.suspendedAt ? 'suspended' : 'active',
    suspendedAt: row.suspendedAt ? row.suspendedAt.toISOString() : null,
  };
}
