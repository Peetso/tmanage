import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { requireId, requireReason } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import type { PlatformPersonView, RequestContext, ResetMailer } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';

/**
 * Platform admin · People — search by email, sign out everywhere, send the ordinary reset email.
 * Moved out of `PlatformAdminService` unchanged (PA-02 split); PA-06 owns it next. Both actions
 * keep their required reason (SPEC P6).
 */
export class PlatformPeopleService {
  constructor(
    private readonly repository: PlatformAdminRepository,
    private readonly resets: ResetMailer,
  ) {}

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
  ) {
    const id = requireId(rawId);
    const reason = requireReason(body?.reason);
    const person = await this.repository.findPerson(id, context.correlationId);
    if (!person) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    // Audited first: if composing the mail fails, the attempt is still on the record.
    await this.repository.recordAudit(
      platformAuditFor(actor, context, {
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
}
