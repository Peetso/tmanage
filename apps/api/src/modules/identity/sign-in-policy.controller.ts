import { Body, Controller, Get, Headers, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import {
  Ctx,
  CurrentPrincipal,
  CurrentSession,
  RequireCapability,
} from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { AuthenticatedSession } from './session.service.js';
import { isStepUpFresh } from './sign-in-policy.service.js';
import type { SignInPolicyService, SignInPolicyState } from './sign-in-policy.service.js';

/** DI tokens, co-located so no `tokens.ts` edit is needed for this slice. */
export const SIGN_IN_POLICY_SERVICE = Symbol.for('tmanage.SignInPolicyService');
export const SIGN_IN_POLICY_SECRET = Symbol.for('tmanage.SignInPolicySecret');

/**
 * 56-25 (R18-e) — the organization sign-in policy.
 *
 * - `GET …/security/sign-in-policy` — allowed methods, who must use two-step (and the grace
 *   deadline), the session length in force (read-only), and how many members have no way in but a
 *   password.
 * - `PUT …/security/sign-in-policy` `{allowedMethods, requireTwoStepRoles}` — step-up gated: the
 *   `x-reauth-token` header from `POST /v1/auth/reauth`, bound to this person and session.
 *
 * Capability: `org.security.manage` (exists; no capabilities.ts edit) on both. Withheld from the AI
 * action registry (`never.ts`, reason `org_security_manage`).
 */
@Controller('v1/organizations/:orgSlug/security')
export class SignInPolicyController {
  constructor(
    @Inject(SIGN_IN_POLICY_SERVICE) private readonly service: SignInPolicyService,
    @Inject(SIGN_IN_POLICY_SECRET) private readonly sessionSecret: string | undefined,
  ) {}

  @Get('sign-in-policy')
  @RequireCapability('org.security.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SignInPolicyState> {
    return this.service.read(context, principal);
  }

  @Put('sign-in-policy')
  @RequireCapability('org.security.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @CurrentSession() session: AuthenticatedSession,
    @Headers('x-reauth-token') reauthToken?: string,
  ): Promise<SignInPolicyState> {
    const fresh = isStepUpFresh({
      token: typeof reauthToken === 'string' && reauthToken !== '' ? reauthToken : undefined,
      secret: this.sessionSecret,
      userId: principal.userId,
      sessionId: session?.sessionId,
    });
    return this.service.update(context, principal, body, fresh);
  }
}
