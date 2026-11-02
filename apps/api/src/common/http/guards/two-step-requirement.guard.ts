import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../errors.js';
import { IS_PUBLIC, SKIPS_TENANT } from '../decorators.js';
import { requireRequestState } from '../request-state.js';
import { TENANT_DATABASE } from '../tokens.js';
import type { TenantDatabase } from '../../database/tenant-context.js';
import { readOrgSwitch } from '../../../modules/tenancy/org-policy.js';
import { OrgSettingsRepository } from '../../../modules/tenancy/org-settings.repository.js';
import { hasActiveSecondFactorRow } from '../../../modules/identity/second-factor-presence.repository.js';
import { parseSignInPolicy, twoStepRequiredFor, twoStepScopeCovers } from '@tmanage/domain';
import { SignInPolicyRepository } from '../../../modules/identity/sign-in-policy.repository.js';

/** R18-e (56-25). Set while a person must enrol but is still inside the grace period. */
export const TWO_STEP_GRACE_HEADER = 'X-TManage-Two-Step-Grace';

/**
 * A11 — the company switch "Everyone must use two-step sign-in", enforced.
 *
 * Runs after `TenantContextGuard` (the organization is proved) and before `CapabilityGuard`. When
 * the acting organization has the switch on and the signed-in person holds no confirmed, active
 * second factor, every tenant-scoped route answers 403 `two_step_required` until they enrol. The
 * web client sends them to the enrolment screen on that code.
 *
 * ## What stays reachable
 *
 * Enrolment, sign-out, sessions, factors and recovery codes are all `@NoTenant()` routes (they are
 * about the person, not the company), so this guard never runs on them. Of the tenant-scoped
 * routes only the person's own profile and own preferences are let through, so the screens around
 * the enrolment page still show the right name, language and theme.
 *
 * ## No self lock-out
 *
 * Nobody can be locked out: the enrolment routes are always open. On top of that the one writer
 * of the switch — the owner-only `PUT …/admin/security` (`enforce2fa`, wave 9 S8 / F09) — refuses
 * to turn it on for someone who has not enrolled themselves (`assertCanRequireTwoStep`), so an
 * owner turning it on is already compliant. The generic settings route never writes this key.
 *
 * It only ever refuses — it never widens what the other guards allow.
 */
@Injectable()
export class TwoStepRequirementGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(OrgSettingsRepository)
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
    @Optional()
    @Inject(SignInPolicyRepository)
    private readonly signInPolicy: SignInPolicyRepository = new SignInPolicyRepository(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIPS_TENANT, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<{ readonly url?: string }>();
    const state = requireRequestState(request);
    const tenant = state.tenant;
    const session = state.session;
    // TenantContextGuard refuses a tenant route without both; nothing to decide here.
    if (!tenant || !session) return true;
    if (isTwoStepExemptPath(request.url)) return true;

    const required = await readOrgSwitch(this.database, tenant, 'require_two_step', this.settings);
    if (required) {
      if (await hasActiveSecondFactor(this.database, session.userId, state.correlationId)) {
        return true;
      }
      throw twoStepRequiredError();
    }

    // R18-e (56-25). The sign-in policy's role rule: 'admins' or 'everyone' (internal roles) must
    // hold a factor; inside the grace period they pass with a warning header, after it they are
    // refused. Owners are never refused in the beta (header only). Needs the resolved role.
    const role = state.membership?.role;
    if (role === undefined) return true;
    const policy = parseSignInPolicy(
      await this.database.read(tenant, (runner) => this.signInPolicy.readDocument(runner, tenant)),
    );
    if (!twoStepScopeCovers(policy.requireTwoStepRoles, role)) return true;
    const verdict = twoStepRequiredFor({
      policy,
      roleKey: role,
      isOwner: role === 'owner',
      hasSecondFactor: await hasActiveSecondFactor(
        this.database,
        session.userId,
        state.correlationId,
      ),
      now: new Date(),
    });
    if (verdict === false) return true;
    if (verdict === 'grace') {
      const http = context.switchToHttp();
      const reply =
        typeof http.getResponse === 'function'
          ? http.getResponse<{ header?: (name: string, value: string) => unknown }>()
          : undefined;
      reply?.header?.(TWO_STEP_GRACE_HEADER, policy.graceUntil ?? 'owner');
      return true;
    }
    throw twoStepRequiredError();
  }
}

/** The refusal a person without a second factor gets while their company requires one. */
export function twoStepRequiredError(): ApiError {
  return new ApiError(
    403,
    'two_step_required',
    'Your company requires two-step sign-in. Turn it on to continue.',
    undefined,
    'org_policy:require_two_step',
  );
}

/**
 * The tenant-scoped routes a person still reaches before enrolling: their own profile and own
 * preferences. Matched on the real path (query removed), anchored, so a query string naming one
 * of these paths exempts nothing.
 */
const EXEMPT_PATH =
  /^\/v1\/organizations\/[^/]+\/me\/(?:profile|preferences|display-preferences|accessibility)(?:\/|$)/;

export function isTwoStepExemptPath(url: string | undefined): boolean {
  if (typeof url !== 'string') return false;
  const path = url.split('?')[0] ?? '';
  return EXEMPT_PATH.test(path);
}

/**
 * Whether the person holds a confirmed, not-disabled second factor. A half-finished enrolment does
 * not count — the same rule sign-in uses (`CredentialsRepository.listActiveFactors`).
 */
export async function hasActiveSecondFactor(
  database: TenantDatabase,
  userId: string,
  correlationId: string,
): Promise<boolean> {
  return database.identityRead({ correlationId, tables: ['user_mfa_factors'] }, (runner) =>
    hasActiveSecondFactorRow(runner, userId),
  );
}

/**
 * The settings route's half of "no self lock-out": turning the switch on is refused (409) for a
 * person who has not enrolled themselves. Turning it off, or any other key, is never affected.
 */
export async function assertCanRequireTwoStep(
  database: TenantDatabase,
  userId: string,
  correlationId: string,
): Promise<void> {
  if (await hasActiveSecondFactor(database, userId, correlationId)) return;
  throw new ApiError(
    409,
    'conflict',
    'Turn on two-step sign-in for your own account first.',
    [{ field: 'value', message: 'Turn on two-step sign-in for your own account first.' }],
    'org_policy:require_two_step:actor_not_enrolled',
  );
}
