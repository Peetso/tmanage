import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { optionalReason, requireId, requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import type { RequestContext, ResetMailer } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import {
  EmailTakenError,
  PEOPLE_ACTIONS_PAGE_SIZE,
  PEOPLE_PAGE_SIZE,
} from './people.repository.js';
import type {
  MembershipRow,
  PeopleFilter,
  PersonRow,
  PlatformPeopleRepository,
  ProfileChange,
} from './people.repository.js';

/**
 * Platform admin v2 · People (PA-06, SPEC §4 B1–B4, §5.3).
 *
 * - B1 list: "browse all" when `q` is empty, every filter of §5.3, keyset paging by user id.
 *   `?email=` stays an alias of `q` (the team screen's person picker searches by email).
 * - B2 profile: name, email, language, time zone. A new email is unverified, ends every session,
 *   sends the reset link to the new address (the existing mailbox proof, which also stamps
 *   `email_verified_at`) and tells the old and the new address. A taken email is a 409.
 * - B3 security: sessions (live + the last 30 days), end one, sign out everywhere, send reset,
 *   reset two-step (reason required), require two-step at next sign-in, disable (reason required)
 *   and enable, failed sign-ins and step-ups.
 * - B4 organizations: every membership with role, scope, overrides count.
 *
 * Every write writes `platform_admin_audit_events` (who, what, before/after, IP, device, reason).
 */

// ── Views (paired in e2e/contracts/api-web-shapes.ts) ─────────────────────

export interface PlatformPeopleOrgChipView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly audience: 'internal' | 'client';
  readonly role: string;
  readonly status: string;
}

export interface PlatformPeopleRowView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
  readonly mfaEnabled: boolean;
  readonly locale: string;
  readonly status: 'active' | 'disabled';
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly disabledByEmail: string | null;
  readonly liveSessions: number;
  readonly companies: readonly PlatformPeopleOrgChipView[];
}

export interface PlatformPeopleListView {
  readonly people: readonly PlatformPeopleRowView[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface PlatformPersonFactsView {
  readonly createdAt: string;
  readonly emailVerifiedAt: string | null;
  readonly lastSignInAt: string | null;
  readonly lastSignInDevice: string | null;
  readonly twoStepKind: string | null;
  readonly twoStepSetUpAt: string | null;
  readonly recoveryCodesLeft: number;
  readonly passwordSetAt: string | null;
  readonly personalAccessTokens: number;
  readonly aiAppGrants: number;
}

export interface PlatformPersonActionView {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly action: string;
  readonly objectType: string;
  readonly result: string;
  readonly occurredAt: string;
  readonly viaSupport: boolean;
}

export interface PlatformPersonAccessView {
  readonly id: string;
  readonly action: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly occurredAt: string;
}

export interface PlatformPersonDetailView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly locale: string;
  readonly timezone: string;
  readonly emailVerified: boolean;
  readonly mfaEnabled: boolean;
  readonly status: 'active' | 'disabled';
  readonly disabledAt: string | null;
  readonly disabledReason: string | null;
  readonly disabledByEmail: string | null;
  readonly twoStepRequired: boolean;
  readonly liveSessions: number;
  readonly facts: PlatformPersonFactsView;
  readonly companies: readonly PlatformPeopleOrgChipView[];
  readonly recentActions: readonly PlatformPersonActionView[];
  readonly recentAccess: readonly PlatformPersonAccessView[];
}

export interface PlatformPersonSessionView {
  readonly id: string;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly ipFirst: string | null;
  readonly ipLast: string | null;
  readonly state: 'live' | 'ended' | 'expired';
}

export interface PlatformPersonSessionsView {
  readonly sessions: readonly PlatformPersonSessionView[];
  readonly live: number;
  readonly endedRecently: number;
}

export interface PlatformPersonStepUpView {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly mfaVerified: boolean;
}

export interface PlatformPersonAccessListView {
  readonly events: readonly PlatformPersonAccessView[];
  readonly stepUps: readonly PlatformPersonStepUpView[];
}

export interface PlatformPersonActionsView {
  readonly actions: readonly PlatformPersonActionView[];
  readonly nextCursor: string | null;
}

export interface PlatformPersonMembershipView {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly organizationStatus: 'active' | 'suspended' | 'archived';
  readonly audience: 'internal' | 'client';
  readonly role: string;
  /** The custom role's name when `role` is a custom role id; `null` for a built-in role. */
  readonly customRoleName: string | null;
  readonly status: string;
  readonly scope: 'org_wide' | 'assigned';
  readonly projects: number;
  readonly clientOrganizationName: string | null;
  readonly overridesAllow: number;
  readonly overridesDeny: number;
  readonly isOwner: boolean;
}

export interface PlatformPersonOrganizationsView {
  readonly memberships: readonly PlatformPersonMembershipView[];
}

export interface PlatformPersonSecurityResultView {
  readonly person: PlatformPersonDetailView;
  readonly sessionsEnded: number;
}

// ── Input parsing ──────────────────────────────────────────────────────────

const LOCALE_SHAPE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ROLE_SHAPE = /^[a-z0-9_:-]{2,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the highlighted field.', [
    { field, message },
  ]);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function bool(value: unknown, field: string): boolean | null {
  const raw = str(value);
  if (raw === null || raw === 'any') return null;
  if (raw === 'true' || raw === 'on' || raw === 'yes' || raw === '1') return true;
  if (raw === 'false' || raw === 'off' || raw === 'no' || raw === '0') return false;
  throw invalid(field, 'true or false');
}

function day(value: unknown, field: string): Date | null {
  const raw = str(value);
  if (raw === null) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw invalid(field, 'an ISO date');
  return parsed;
}

export type PeopleQuery = Readonly<Record<string, unknown>>;

/** `GET people?…` → the repository filter. Every value validated; unknown values are 400s. */
export function parsePeopleFilter(query: PeopleQuery): PeopleFilter {
  const q = str(query['q']) ?? str(query['email']);
  if (q !== null && q.length > 254) throw invalid('q', 'at most 254 characters');
  const status = str(query['status']);
  if (status !== null && status !== 'active' && status !== 'disabled' && status !== 'any') {
    throw invalid('status', 'active, disabled or any');
  }
  const locale = str(query['locale']);
  if (locale !== null && !LOCALE_SHAPE.test(locale)) throw invalid('locale', 'a language tag');
  const organizationId = str(query['organizationId']);
  if (organizationId !== null && !UUID.test(organizationId)) {
    throw invalid('organizationId', 'an organization id');
  }
  const role = str(query['role']);
  if (role !== null && !ROLE_SHAPE.test(role)) throw invalid('role', 'a role name');
  const cursor = str(query['cursor']);
  if (cursor !== null && !UUID.test(cursor)) throw invalid('cursor', 'the cursor of a page');
  const rawLimit = str(query['limit']);
  const limit = rawLimit === null ? PEOPLE_PAGE_SIZE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('limit', '1–100');
  return {
    q,
    status: status === 'active' || status === 'disabled' ? status : null,
    verified: bool(query['verified'], 'verified'),
    mfa: bool(query['mfa'], 'mfa'),
    locale,
    organizationId,
    role,
    signInFrom: day(query['signInFrom'], 'signInFrom'),
    signInTo: day(query['signInTo'], 'signInTo'),
    hasSessions: bool(query['hasSessions'], 'hasSessions'),
    cursor,
    limit,
  };
}

/** `PATCH people/:userId` body → the change. At least one field; each validated. */
export function parseProfileChange(body: Readonly<Record<string, unknown>>): ProfileChange {
  const change: { -readonly [K in keyof ProfileChange]: ProfileChange[K] } = {};
  if (body['displayName'] !== undefined) {
    const name = str(body['displayName']);
    if (name === null || name.length > 190) throw invalid('displayName', '1–190 characters');
    change.displayName = name;
  }
  if (body['email'] !== undefined) {
    const email = str(body['email'])?.toLowerCase() ?? null;
    if (email === null || email.length > 254 || !EMAIL_SHAPE.test(email)) {
      throw invalid('email', 'an email address');
    }
    change.email = email;
  }
  if (body['locale'] !== undefined) {
    const locale = str(body['locale']);
    if (locale === null || locale.length > 35 || !LOCALE_SHAPE.test(locale)) {
      throw invalid('locale', 'a language tag');
    }
    change.locale = locale;
  }
  if (body['timezone'] !== undefined) {
    const zone = str(body['timezone']);
    if (zone === null || zone.length > 64 || !isTimeZone(zone)) {
      throw invalid('timezone', 'an IANA time zone');
    }
    change.timezone = zone;
  }
  if (Object.keys(change).length === 0) throw invalid('displayName', 'nothing to change');
  return change;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

function orgStatus(row: MembershipRow): PlatformPersonMembershipView['organizationStatus'] {
  if (row.organizationArchivedAt !== null) return 'archived';
  if (row.organizationSuspendedAt !== null) return 'suspended';
  return 'active';
}

function chip(row: MembershipRow): PlatformPeopleOrgChipView {
  return {
    id: row.organizationId,
    name: row.organizationName,
    slug: row.organizationSlug,
    audience: row.audience,
    role: row.customRoleName ?? row.role,
    status: row.status,
  };
}

function profileOf(person: PersonRow): Record<string, unknown> {
  return {
    displayName: person.displayName,
    email: person.email,
    locale: person.locale,
    timezone: person.timezone,
  };
}

/** The address an email change sends the verification link to (the reset path). */
export type VerificationMailer = ResetMailer;

/** Tells the old and the new address that the sign-in email changed. */
export interface EmailChangeNotices {
  notify(input: {
    readonly displayName: string;
    readonly oldEmail: string;
    readonly newEmail: string;
    readonly locale?: string;
  }): Promise<unknown>;
}

export class PlatformPeopleService {
  constructor(
    private readonly platform: PlatformAdminRepository,
    private readonly people: PlatformPeopleRepository,
    private readonly resets: ResetMailer,
    private readonly notices: EmailChangeNotices,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(query: PeopleQuery, context: RequestContext): Promise<PlatformPeopleListView> {
    const filter = parsePeopleFilter(query);
    const found = await this.people.listPeople(filter, context.correlationId);
    const rows = found.people.map((person) => ({
      ...this.rowOf(person),
      companies: found.memberships
        .filter((membership) => membership.userId === person.userId)
        .map(chip),
    }));
    const last = found.people[found.people.length - 1];
    return {
      people: rows,
      total: found.total,
      nextCursor: found.hasMore && last ? last.userId : null,
    };
  }

  async detail(rawId: unknown, context: RequestContext): Promise<PlatformPersonDetailView> {
    const id = requireId(rawId);
    const person = await this.requirePerson(id, context);
    return this.detailOf(person, context);
  }

  async sessions(rawId: unknown, context: RequestContext): Promise<PlatformPersonSessionsView> {
    const id = requireId(rawId);
    await this.requirePerson(id, context);
    const rows = await this.people.sessions(id, context.correlationId);
    const sessions = rows.map((row): PlatformPersonSessionView => {
      const state: PlatformPersonSessionView['state'] =
        row.revokedAt !== null ? 'ended' : row.expired ? 'expired' : 'live';
      return {
        id: row.id,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        lastActiveAt: row.lastActiveAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        revokedAt: iso(row.revokedAt),
        revokedReason: row.revokedReason,
        ipFirst: row.ipFirst,
        ipLast: row.ipLast,
        state,
      };
    });
    return {
      sessions,
      live: sessions.filter((session) => session.state === 'live').length,
      endedRecently: sessions.filter((session) => session.state !== 'live').length,
    };
  }

  async access(
    rawId: unknown,
    query: PeopleQuery,
    context: RequestContext,
  ): Promise<PlatformPersonAccessListView> {
    const id = requireId(rawId);
    await this.requirePerson(id, context);
    const to = day(query['to'], 'to') ?? this.now();
    const from = day(query['from'], 'from') ?? new Date(to.getTime() - 30 * 86_400_000);
    const outcome = str(query['outcome']);
    if (outcome !== null && outcome !== 'failed') throw invalid('outcome', 'failed');
    const found = await this.people.access(
      id,
      { from, to, outcome: outcome === 'failed' ? 'failed' : null },
      context.correlationId,
    );
    return {
      events: found.events.map((event) => ({
        id: event.id,
        action: event.action,
        outcome: event.outcome,
        reason: event.reason,
        ip: event.ip,
        userAgent: event.userAgent,
        occurredAt: event.occurredAt.toISOString(),
      })),
      stepUps: found.stepUps.map((step) => ({
        id: step.id,
        createdAt: step.createdAt.toISOString(),
        expiresAt: step.expiresAt.toISOString(),
        mfaVerified: step.mfaVerified,
      })),
    };
  }

  async actions(
    rawId: unknown,
    query: PeopleQuery,
    context: RequestContext,
  ): Promise<PlatformPersonActionsView> {
    const id = requireId(rawId);
    await this.requirePerson(id, context);
    const to = day(query['to'], 'to') ?? this.now();
    const from = day(query['from'], 'from') ?? new Date(0);
    const rawCursor = str(query['cursor']);
    let cursor: { at: Date; id: string } | null = null;
    if (rawCursor !== null) {
      const [at, eventId] = rawCursor.split('_');
      const when = at === undefined ? null : new Date(at);
      if (!when || Number.isNaN(when.getTime()) || eventId === undefined || !UUID.test(eventId)) {
        throw invalid('cursor', 'the cursor of a page');
      }
      cursor = { at: when, id: eventId };
    }
    const found = await this.people.actions(
      id,
      { from, to, cursor, limit: PEOPLE_ACTIONS_PAGE_SIZE },
      context.correlationId,
    );
    const actions = found.actions.map((row) => this.actionOf(row));
    const last = actions[actions.length - 1];
    return {
      actions,
      nextCursor: found.hasMore && last ? `${last.occurredAt}_${last.id}` : null,
    };
  }

  async organizations(
    rawId: unknown,
    context: RequestContext,
  ): Promise<PlatformPersonOrganizationsView> {
    const id = requireId(rawId);
    await this.requirePerson(id, context);
    const rows = await this.people.memberships(id, context.correlationId);
    const memberships = await Promise.all(
      rows.map(async (row): Promise<PlatformPersonMembershipView> => {
        const counts =
          row.audience === 'internal'
            ? await this.people.overrideCounts(
                row.organizationId,
                row.membershipId,
                id,
                context.correlationId,
              )
            : { allow: 0, deny: 0, projects: 0 };
        return {
          membershipId: row.membershipId,
          organizationId: row.organizationId,
          organizationName: row.organizationName,
          organizationSlug: row.organizationSlug,
          organizationStatus: orgStatus(row),
          audience: row.audience,
          role: row.role,
          customRoleName: row.customRoleName,
          status: row.status,
          scope: row.orgWide ? 'org_wide' : 'assigned',
          projects: counts.projects,
          clientOrganizationName: row.clientOrganizationName,
          overridesAllow: counts.allow,
          overridesDeny: counts.deny,
          isOwner: row.audience === 'internal' && row.role === 'owner',
        };
      }),
    );
    return { memberships };
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async updateProfile(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: Readonly<Record<string, unknown>>,
    context: RequestContext,
  ): Promise<PlatformPersonDetailView> {
    const id = requireId(rawId);
    const change = parseProfileChange(body ?? {});
    const reason = optionalReason(body?.['reason']);
    const person = await this.requirePerson(id, context);
    const emailChanged = change.email !== undefined && change.email !== person.email;
    const before = profileOf(person);
    const after = { ...before, ...change };
    try {
      await this.people.updateProfile(
        id,
        change,
        emailChanged,
        platformAuditFor(actor, context, {
          action: 'platform.user_profile_updated',
          targetType: 'user',
          targetId: id,
          targetLabel: person.email,
          reason,
          beforeJson: JSON.stringify(before),
          afterJson: JSON.stringify(after),
        }),
      );
    } catch (error) {
      if (error instanceof EmailTakenError) {
        throw new ApiError(
          409,
          'conflict',
          'That email already belongs to another account.',
          [{ field: 'email', message: 'already belongs to another account' }],
          'platform_people:email_taken',
        );
      }
      throw error;
    }
    if (emailChanged && change.email !== undefined) {
      // The verification: the ordinary reset link to the NEW address (spending it stamps
      // `email_verified_at`, F03). Then the notice to both addresses. Neither undoes the change.
      await this.resets.request(change.email, context).catch(() => undefined);
      await this.notices
        .notify({
          displayName: change.displayName ?? person.displayName,
          oldEmail: person.email,
          newEmail: change.email,
          locale: change.locale ?? person.locale,
        })
        .catch(() => undefined);
    }
    return this.detail(id, context);
  }

  async signOutEverywhere(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<{ readonly sessionsEnded: number }> {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    const person = await this.requirePerson(id, context);
    const ended = await this.platform.signOutEverywhere(
      id,
      platformAuditFor(actor, context, {
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
  ): Promise<{ readonly status: 'sent' }> {
    const id = requireId(rawId);
    // Kept required (wave 9): the reset is a security action on someone else's account.
    const reason = requireReason(body?.reason);
    const person = await this.requirePerson(id, context);
    await this.platform.recordAudit(
      platformAuditFor(actor, context, {
        action: 'platform.password_reset_sent',
        targetType: 'user',
        targetId: id,
        targetLabel: person.email,
        reason,
      }),
    );
    await this.resets.request(person.email, context);
    return { status: 'sent' };
  }

  async endSession(
    actor: PlatformAdminActor,
    rawId: unknown,
    rawSessionId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<{ readonly ended: true }> {
    const id = requireId(rawId);
    const sessionId = requireId(rawSessionId);
    const reason = requireReason(body?.reason);
    const person = await this.requirePerson(id, context);
    const ended = await this.people.endSession(
      id,
      sessionId,
      platformAuditFor(actor, context, {
        action: 'platform.user_session_ended',
        targetType: 'user',
        targetId: id,
        targetLabel: person.email,
        reason,
        afterJson: JSON.stringify({ sessionId }),
      }),
    );
    if (!ended) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { ended: true };
  }

  async resetTwoStep(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown; readonly signOut?: unknown },
    context: RequestContext,
  ): Promise<PlatformPersonSecurityResultView> {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    const signOut = body?.signOut === true;
    const person = await this.requirePerson(id, context);
    const result = await this.people.resetTwoStep(
      id,
      signOut,
      platformAuditFor(actor, context, {
        action: 'platform.user_two_step_reset',
        targetType: 'user',
        targetId: id,
        targetLabel: person.email,
        reason,
        beforeJson: JSON.stringify({ mfaEnabled: person.mfaEnabled }),
        afterJson: JSON.stringify({ mfaEnabled: false, twoStepRequired: true, signOut }),
      }),
    );
    return { person: await this.detail(id, context), sessionsEnded: result.sessionsEnded };
  }

  async setTwoStepRequired(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly required?: unknown; readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformPersonDetailView> {
    const id = requireId(rawId);
    if (typeof body?.required !== 'boolean') throw invalid('required', 'true or false');
    const required = body.required;
    const reason = optionalReason(body.reason);
    const person = await this.requirePerson(id, context);
    await this.people.setTwoStepRequired(
      id,
      required,
      platformAuditFor(actor, context, {
        action: required
          ? 'platform.user_two_step_required'
          : 'platform.user_two_step_not_required',
        targetType: 'user',
        targetId: id,
        targetLabel: person.email,
        reason,
        beforeJson: JSON.stringify({ twoStepRequired: person.twoStepRequiredAt !== null }),
        afterJson: JSON.stringify({ twoStepRequired: required }),
      }),
    );
    return this.detail(id, context);
  }

  async disable(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformPersonSecurityResultView> {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    if (id === actor.account.userId) {
      throw new ApiError(
        409,
        'conflict',
        'You cannot disable your own account.',
        [{ field: 'userId', message: 'your own account' }],
        'platform_people:disable_self',
      );
    }
    const person = await this.requirePerson(id, context);
    const ended = await this.people.disable(
      id,
      reason,
      platformAuditFor(actor, context, {
        action: 'platform.user_disabled',
        targetType: 'user',
        targetId: id,
        targetLabel: person.email,
        reason,
        beforeJson: JSON.stringify({ status: person.disabledAt ? 'disabled' : 'active' }),
        afterJson: JSON.stringify({ status: 'disabled' }),
      }),
    );
    return { person: await this.detail(id, context), sessionsEnded: ended };
  }

  async enable(
    actor: PlatformAdminActor,
    rawId: unknown,
    body: { readonly reason?: unknown },
    context: RequestContext,
  ): Promise<PlatformPersonDetailView> {
    const id = requireId(rawId);
    const reason = optionalReason(body?.reason);
    const person = await this.requirePerson(id, context);
    await this.people.enable(
      id,
      platformAuditFor(actor, context, {
        action: 'platform.user_enabled',
        targetType: 'user',
        targetId: id,
        targetLabel: person.email,
        reason,
        beforeJson: JSON.stringify({ status: person.disabledAt ? 'disabled' : 'active' }),
        afterJson: JSON.stringify({ status: 'active' }),
      }),
    );
    return this.detail(id, context);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async requirePerson(id: string, context: RequestContext): Promise<PersonRow> {
    const person = await this.people.findPerson(id, context.correlationId);
    if (!person) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return person;
  }

  private rowOf(person: PersonRow): Omit<PlatformPeopleRowView, 'companies'> {
    return {
      id: person.userId,
      email: person.email,
      displayName: person.displayName,
      emailVerified: person.emailVerifiedAt !== null,
      createdAt: person.createdAt.toISOString(),
      lastSignInAt: iso(person.lastSignInAt),
      mfaEnabled: person.mfaEnabled,
      locale: person.locale,
      status: person.disabledAt === null ? 'active' : 'disabled',
      disabledAt: iso(person.disabledAt),
      disabledReason: person.disabledReason,
      disabledByEmail: person.disabledByEmail,
      liveSessions: person.liveSessions,
    };
  }

  private actionOf(row: {
    id: string;
    organizationId: string;
    organizationName: string;
    action: string;
    objectType: string;
    result: string;
    occurredAt: Date;
    viaSupport: boolean;
  }): PlatformPersonActionView {
    return { ...row, occurredAt: row.occurredAt.toISOString() };
  }

  private async detailOf(
    person: PersonRow,
    context: RequestContext,
  ): Promise<PlatformPersonDetailView> {
    const id = person.userId;
    const now = this.now();
    const [security, bearer, memberships, actions, access] = await Promise.all([
      this.people.securityFacts(id, context.correlationId),
      this.people.bearerCounts(id, context.correlationId),
      this.people.memberships(id, context.correlationId),
      this.people.actions(
        id,
        { from: new Date(0), to: now, cursor: null, limit: 3 },
        context.correlationId,
      ),
      this.people.access(
        id,
        { from: new Date(now.getTime() - 30 * 86_400_000), to: now, outcome: null },
        context.correlationId,
      ),
    ]);
    const row = this.rowOf(person);
    return {
      id,
      email: person.email,
      displayName: person.displayName,
      locale: person.locale,
      timezone: person.timezone,
      emailVerified: row.emailVerified,
      mfaEnabled: person.mfaEnabled,
      status: row.status,
      disabledAt: row.disabledAt,
      disabledReason: row.disabledReason,
      disabledByEmail: row.disabledByEmail,
      twoStepRequired: person.twoStepRequiredAt !== null,
      liveSessions: person.liveSessions,
      facts: {
        createdAt: person.createdAt.toISOString(),
        emailVerifiedAt: iso(person.emailVerifiedAt),
        lastSignInAt: iso(person.lastSignInAt),
        lastSignInDevice: person.lastSignInUserAgent,
        twoStepKind: security.factorKind,
        twoStepSetUpAt: iso(security.factorConfirmedAt),
        recoveryCodesLeft: security.recoveryCodesLeft,
        passwordSetAt: iso(security.passwordSetAt),
        personalAccessTokens: bearer.personalAccessTokens,
        aiAppGrants: bearer.aiAppGrants,
      },
      companies: memberships.map(chip),
      recentActions: actions.actions.map((action) => this.actionOf(action)),
      recentAccess: access.events.slice(0, 3).map((event) => ({
        id: event.id,
        action: event.action,
        outcome: event.outcome,
        reason: event.reason,
        ip: event.ip,
        userAgent: event.userAgent,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }
}
