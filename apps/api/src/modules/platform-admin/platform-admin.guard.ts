import { createParamDecorator, Inject, Injectable, Optional, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_PERMISSIONS } from '@tmanage/domain';
import type { PlatformPermission, PlatformPreset } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PLATFORM_ADMIN_GUARD_MARK } from '../../common/http/guards/bound-token-allowlist.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { isPlatformAdminEmail } from './platform-admin.access.js';
import type { PlatformAdminAccount, PlatformStepUp } from './platform-admin.repository.js';
import type { PlatformAdminRecord } from './platform-admins.repository.js';
import { PLATFORM_PERMISSION_METADATA } from './require-platform-permission.decorator.js';

/**
 * The gate in front of every `/v1/platform/*` route. It runs after the global session guard
 * (so a session exists) and the routes are `@NoTenant()`, so no organization role is ever
 * consulted — an owner of every company on the server is refused exactly like a stranger.
 *
 * Two sources make someone a platform admin (platform-admin v2, SPEC §3.1):
 * - **the server list** — a verified email in `PLATFORM_ADMIN_EMAILS` is always `super_admin`
 *   (the bootstrap; it cannot be locked out from the screen);
 * - **the team table** — an `active` `platform_admins` row, with its preset or custom list.
 *
 * In order, each a refusal on its own:
 *
 * 1. **The feature is on** — the server list names someone, or the team has an active row.
 * 2. **A browser session**, not a personal access token. ADR-0015 part 2 adds one exact
 *    alternative: an in-process AI internal grant that carries `stepUpSessionId` (set by server
 *    code only: the cookie chat, the approve page, an OAuth grant with `tmanage:platform`; never a
 *    PAT). Rules 3–5 then run unchanged against that session, which must also still be signed in;
 *    an external grant's platform window (`platformUntil`, F1) must not have ended.
 * 3. **A verified account that is on the list or on the team** (and not disabled there).
 * 4. **The route's permission** (`@RequirePlatformPermission`) — a 403
 *    `platform_permission_missing` naming the key. Checked before the step-up: stepping up
 *    would not help, and the screen should say what is missing instead of asking for a password.
 * 5. **A fresh step-up** — the password (and MFA code) confirmed in THIS session within the
 *    step-up window (`PLATFORM_STEP_UP_MINUTES`, 24 hours by default) — for every route except
 *    `me` and `step-up` (`@PlatformStepUpExempt()`).
 *
 * Refusals 1–3 are the same 404 any unknown path gets, so the surface does not confirm it
 * exists to someone who is not an admin. Refusals 4–5 are 403s: by then the caller is an admin.
 */

/** Port so the guard is testable without a database. The repository satisfies it. */
export interface PlatformAdminLookup {
  findAccount(userId: string, correlationId: string): Promise<PlatformAdminAccount | null>;
  findLiveStepUp(
    userId: string,
    sessionId: string,
    correlationId: string,
  ): Promise<PlatformStepUp | null>;
  /** The team row (0239). Optional so an env-only lookup (older tests, maintenance) still fits. */
  findPlatformAdmin?(userId: string, correlationId: string): Promise<PlatformAdminRecord | null>;
  /** Whether any team row is active — turns the feature on with an empty server list. */
  hasActivePlatformAdmins?(correlationId: string): Promise<boolean>;
  /**
   * ADR-0015 F1: whether a browser session is still signed in (not revoked, not expired). Read on
   * every AI-grant request, so a sign-out or a revoked session ends the AI's platform reach at
   * once. A lookup without it refuses every AI grant (fail closed).
   */
  isSessionLive?(userId: string, sessionId: string, correlationId: string): Promise<boolean>;
}

export const PLATFORM_ADMIN_LOOKUP = Symbol.for('tmanage.PlatformAdminLookup');
export const PLATFORM_ADMIN_ALLOWLIST = Symbol.for('tmanage.PlatformAdminAllowlist');

const STEP_UP_EXEMPT = Symbol('tmanage.route.platformStepUpExempt');

/** Marks the two routes a platform admin may call before stepping up. */
export const PlatformStepUpExempt = (): MethodDecorator => SetMetadata(STEP_UP_EXEMPT, true);

export type PlatformAdminSource = 'env' | 'db';

/** What the guard proved, for the handler. Held off the request object's shape on purpose. */
export interface PlatformAdminActor {
  readonly account: PlatformAdminAccount;
  readonly sessionId: string;
  readonly stepUp: PlatformStepUp | null;
  // ---- platform-admin v2 · PA-02 ---- (optional so older hand-built actors still type-check)
  /** `env` = on `PLATFORM_ADMIN_EMAILS`; `db` = a `platform_admins` row. */
  readonly source?: PlatformAdminSource;
  /** The team row id, or `null` for a server-list admin without one. */
  readonly adminId?: string | null;
  readonly preset?: PlatformPreset;
  /** Every platform permission this admin holds. Missing = treat as none. */
  readonly permissions?: readonly PlatformPermission[];
  /** Seconds left on the live step-up (0 when there is none). */
  readonly stepUpRemainingSeconds?: number;
  /**
   * ADR-0015 point 9 / F10: the AI client the request runs for (an internal grant), recorded on
   * the platform audit row with the pending action it executes. Absent for a person's own click.
   */
  readonly via?: {
    readonly clientId: string;
    readonly clientName: string;
    readonly pendingActionId: string | null;
  };
}

const ACTORS = new WeakMap<object, PlatformAdminActor>();

export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformAdminActor => {
    const actor = ACTORS.get(context.switchToHttp().getRequest<object>());
    if (!actor) throw new Error('CurrentPlatformAdmin used on a route without PlatformAdminGuard');
    return actor;
  },
);

/** The actor the guard proved for this request, if it ran (56-21: the two-person guard reads it). */
export function platformActorOf(request: object): PlatformAdminActor | undefined {
  return ACTORS.get(request);
}

/**
 * 56-21 — two-step sign-in is required for platform staff. `PLATFORM_STAFF_TWO_STEP` = `required`
 * or `optional` decides; unset, it is required in production and optional elsewhere (the seeded
 * local and journey accounts have no second factor).
 */
export const PLATFORM_STAFF_TWO_STEP = Symbol.for('tmanage.PlatformStaffTwoStep');

export function platformTwoStepRequired(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = (env['PLATFORM_STAFF_TWO_STEP'] ?? '').trim().toLowerCase();
  if (raw === 'required') return true;
  if (raw === 'optional') return false;
  return env['NODE_ENV'] === 'production';
}

/** Whether an actor holds a key — `false` for an actor built without permissions. */
export function actorHas(actor: PlatformAdminActor, permission: PlatformPermission): boolean {
  return (actor.permissions ?? []).includes(permission);
}

export function stepUpRemainingSeconds(stepUp: PlatformStepUp | null, now: Date): number {
  if (!stepUp) return 0;
  return Math.max(0, Math.floor((stepUp.expiresAt.getTime() - now.getTime()) / 1000));
}

export function platformPermissionMissing(permission: PlatformPermission): ApiError {
  return new ApiError(
    403,
    'platform_permission_missing',
    "Your platform permissions don't include this.",
    [{ field: 'permission', message: permission }],
    'platform_permission_missing',
  );
}

function notFound(auditCode: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
}

/** Who the account is on the platform (rule 3), shared by the guard and the AI catalogue (AR-8). */
export type ResolvedPlatformAdmin =
  | {
      readonly ok: true;
      readonly account: PlatformAdminAccount;
      readonly source: PlatformAdminSource;
      readonly preset: PlatformPreset;
      readonly permissions: readonly PlatformPermission[];
      readonly row: PlatformAdminRecord | null;
    }
  | { readonly ok: false; readonly auditCode: string };

/**
 * Rule 3: a verified account on the server list (always `super_admin`, every key) or with an
 * active team row (its preset or custom list). The same decision the guard makes, so the AI
 * catalogue (ADR-0015 point 6) lists a platform op exactly when the guard would let it through.
 */
export async function resolvePlatformAdmin(
  allowlist: readonly string[],
  lookup: PlatformAdminLookup,
  userId: string,
  correlationId: string,
): Promise<ResolvedPlatformAdmin> {
  const account = await lookup.findAccount(userId, correlationId);
  if (!account || !account.emailVerified)
    return { ok: false, auditCode: 'platform_admin_not_listed' };
  const onList = isPlatformAdminEmail(allowlist, account.email);
  const row = lookup.findPlatformAdmin
    ? await lookup.findPlatformAdmin(userId, correlationId)
    : null;
  if (onList) {
    // The server list always wins: a disabled or narrower team row cannot lock out the bootstrap.
    return {
      ok: true,
      account,
      source: 'env',
      preset: 'super_admin',
      permissions: [...PLATFORM_PERMISSIONS],
      row,
    };
  }
  if (row && row.status === 'active') {
    return {
      ok: true,
      account,
      source: 'db',
      preset: row.preset,
      permissions: row.permissions,
      row,
    };
  }
  return {
    ok: false,
    auditCode: row ? 'platform_admin_disabled_row' : 'platform_admin_not_listed',
  };
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  /** ADR-0015 F4: lets `TenantContextGuard` find this guard on a route's own metadata. */
  static readonly [PLATFORM_ADMIN_GUARD_MARK] = true;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PLATFORM_ADMIN_ALLOWLIST) private readonly allowlist: readonly string[],
    @Inject(PLATFORM_ADMIN_LOOKUP) private readonly lookup: PlatformAdminLookup,
    @Optional()
    @Inject(PLATFORM_STAFF_TWO_STEP)
    private readonly twoStepRequired: boolean = platformTwoStepRequired(process.env),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<object>();
    const state = requireRequestState(request);

    if (this.allowlist.length === 0) {
      const anyTeam = this.lookup.hasActivePlatformAdmins
        ? await this.lookup.hasActivePlatformAdmins(state.correlationId)
        : false;
      if (!anyTeam) throw notFound('platform_admin_disabled');
    }

    const session = state.session;
    if (!session) {
      throw new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, 'no_session');
    }
    // Rule 2, and the ADR-0015 exception: a step-up-bound internal grant (server-set binding).
    const grant = state.authScheme === 'ai_grant' ? state.aiGrant : undefined;
    const boundSession = grant?.stepUpSessionId;
    if (state.authScheme !== 'cookie' && (boundSession === undefined || boundSession === '')) {
      throw notFound('platform_admin_token_refused');
    }
    const stepUpSessionId = boundSession ?? session.sessionId;

    const resolved = await resolvePlatformAdmin(
      this.allowlist,
      this.lookup,
      session.userId,
      state.correlationId,
    );
    if (!resolved.ok) throw notFound(resolved.auditCode);
    const { account, source, preset, permissions, row } = resolved;

    const required = this.reflector.getAllAndOverride<PlatformPermission | undefined>(
      PLATFORM_PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (required && !permissions.includes(required)) throw platformPermissionMissing(required);

    let stepUp = await this.lookup.findLiveStepUp(
      session.userId,
      stepUpSessionId,
      state.correlationId,
    );
    if (grant !== undefined) {
      // F1: an external grant's platform window, and the bound session itself, end the reach
      // early (a sign-out, a revoked or expired session) — checked live, never a copied expiry.
      const windowOver = grant.platformUntil !== undefined && grant.platformUntil <= Date.now();
      const live = this.lookup.isSessionLive
        ? await this.lookup.isSessionLive(session.userId, stepUpSessionId, state.correlationId)
        : false;
      if (windowOver || !live) stepUp = null;
    }
    // `me` and `step-up` are exempt for the person's own screen only; an AI grant always needs
    // the live step-up it is bound to (ADR-0015 F1), so an expired window reaches nothing.
    const exempt =
      grant === undefined &&
      this.reflector.getAllAndOverride<boolean>(STEP_UP_EXEMPT, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    // 56-21: platform staff must have two-step sign-in. `me` and `step-up` stay open so the
    // screen can say what is missing; everything else is refused until it is turned on.
    if (!exempt && this.twoStepRequired && !account.mfaEnabled) {
      throw new ApiError(
        403,
        'two_step_required',
        'Turn on two-step sign-in to use Platform admin.',
        undefined,
        'platform_admin_two_step_required',
      );
    }
    if (!exempt && !stepUp) {
      throw new ApiError(
        403,
        'reauthentication_required',
        account.mfaEnabled
          ? 'Confirm your password and two-step code to open Platform admin.'
          : 'Confirm your password to open Platform admin.',
        undefined,
        'platform_admin_step_up_required',
      );
    }

    ACTORS.set(request, {
      account,
      // The browser session the person stepped up in: their own, or the one an AI grant is bound
      // to (a support visit started by the AI belongs to that browser session, F8).
      sessionId: stepUpSessionId,
      stepUp,
      source,
      adminId: row?.id ?? null,
      preset,
      permissions,
      stepUpRemainingSeconds: stepUpRemainingSeconds(stepUp, new Date()),
      ...(grant !== undefined
        ? {
            via: {
              clientId: grant.clientId,
              clientName: grant.clientName,
              pendingActionId: grant.pendingActionId ?? null,
            },
          }
        : {}),
    });
    return true;
  }
}
