import { Body, Controller, HttpCode, Inject, Optional, Param, Post, Req } from '@nestjs/common';
import type { AuditAction } from '@tmanage/domain';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { PASSWORD_RESET_SERVICE } from '../identity/password-reset.controller.js';
import type { PasswordResetContext } from '../identity/password-reset.service.js';
import { MemberPasswordResetRepository } from './member-password-reset.repository.js';

/** Same bounds as the platform admin's `requireReason`. */
export const MIN_RESET_REASON_LENGTH = 5;
export const MAX_RESET_REASON_LENGTH = 500;

/** Catalogued by slice Q3 (`packages/domain` policies/audit.ts), objectType `membership`. */
const RESET_SENT_ACTION: AuditAction = 'member.password_reset_sent';

/** The slice of `PasswordResetService` this route needs. */
export interface MemberResetMailer {
  request(email: unknown, context: PasswordResetContext): Promise<unknown>;
}

interface RequestLike {
  readonly ip?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
}

interface ResetBody {
  readonly reason?: unknown;
}

function requireResetReason(raw: unknown): string {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < MIN_RESET_REASON_LENGTH || reason.length > MAX_RESET_REASON_LENGTH) {
    throw new ApiError(422, 'validation_failed', 'Type the reason for this reset.', [
      {
        field: 'reason',
        message: `required, ${MIN_RESET_REASON_LENGTH}–${MAX_RESET_REASON_LENGTH} characters`,
      },
    ]);
  }
  return reason;
}

/**
 * Q4 — an organization admin sends a member the ordinary reset link.
 *
 * The org-scoped mirror of `PlatformAdminService.sendPasswordReset`: the admin never sees the
 * link and never sets a password; the member gets the same single-use 30-minute self-service
 * email they could have asked for themselves. Order: reason (422), resolve the membership in
 * the caller's tenant (404 — a foreign id reads like an unknown one), refuse yourself and a
 * membership that is not active (422), write `member.password_reset_sent` and commit it, and
 * only then request the link — so a failed delivery is still on the record.
 *
 * The tenant audit metadata rule (identifiers only; no `email`/`reason` keys) means the row
 * carries the membership id and the member's user id, not the address or the typed reason.
 */
@Controller('v1/organizations/:orgSlug/members')
export class MemberPasswordResetController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PASSWORD_RESET_SERVICE) private readonly resets: MemberResetMailer,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Optional()
    @Inject(MemberPasswordResetRepository)
    private readonly members: MemberPasswordResetRepository = new MemberPasswordResetRepository(),
  ) {}

  @Post(':membershipId/password-reset')
  @HttpCode(202)
  @RequireCapability('org.manage')
  async send(
    @Ctx() context: TenantContext,
    @Param('membershipId') membershipId: string,
    @Body() body: ResetBody,
    @Req() request?: RequestLike,
  ): Promise<{ readonly status: 'sent' }> {
    requireResetReason(body?.reason);

    const email = await this.database.transaction(context, async (tx) => {
      const member = await this.members.findMember(tx, context, membershipId);
      if (!member) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      if (member.membershipId === context.membershipId || member.userId === context.userId) {
        throw new ApiError(
          422,
          'validation_failed',
          'Use Forgot password to reset your own password.',
          undefined,
          'member_password_reset.self',
        );
      }
      if (member.status !== 'active') {
        throw new ApiError(
          422,
          'validation_failed',
          'Only an active member can be sent a reset link.',
          undefined,
          'member_password_reset.inactive',
        );
      }
      await this.audit.record(tx, context, {
        action: RESET_SENT_ACTION,
        objectId: member.membershipId,
        result: 'allowed',
        metadata: { target_user_id: member.userId },
      });
      return member.email;
    });

    const userAgent = request?.headers?.['user-agent'];
    await this.resets.request(email, {
      correlationId: context.correlationId,
      ip: request?.ip ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null,
    });
    return { status: 'sent' };
  }
}
