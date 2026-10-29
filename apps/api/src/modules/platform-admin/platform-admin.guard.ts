import { createParamDecorator, Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_PERMISSIONS } from '@tmanage/domain';
import type { PlatformPermission, PlatformPreset } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
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
 * 2. **A browser session**, not a personal access token.
 * 3. **A verified account that is on the list or on the team** (and not disabled there).
 * 4. **The route's permission** (`@RequirePlatformPermission`) — a 403
 *    `platform_permission_missing` naming the key. Checked before the step-up: stepping up
 *    would not help, and the screen should say what is missing instead of asking for a password.
 * 5. **A fresh step-up** — the password (and MFA code) confirmed in THIS session within the
 *    last 15 minutes — for every route except `me` and `step-up` (`@PlatformStepUpExempt()`).
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
}

const ACTORS = new WeakMap<object, PlatformAdminActor>();

export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformAdminActor => {
    const actor = ACTORS.get(context.switchToHttp().getRequest<object>());
    if (!actor) throw new Error('CurrentPlatformAdmin used on a route without PlatformAdminGuard');
    return actor;
  },
);

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

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PLATFORM_ADMIN_ALLOWLIST) private readonly allowlist: readonly string[],
    @Inject(PLATFORM_ADMIN_LOOKUP) private readonly lookup: PlatformAdminLookup,
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
    if (state.authScheme !== 'cookie') throw notFound('platform_admin_token_refused');

    const account = await this.lookup.findAccount(session.userId, state.correlationId);
    if (!account || !account.emailVerified) throw notFound('platform_admin_not_listed');

    const onList = isPlatformAdminEmail(this.allowlist, account.email);
    const row = this.lookup.findPlatformAdmin
      ? await this.lookup.findPlatformAdmin(session.userId, state.correlationId)
      : null;
    let source: PlatformAdminSource;
    let preset: PlatformPreset;
    let permissions: readonly PlatformPermission[];
    if (onList) {
      // The server list always wins: a disabled or narrower team row cannot lock out the bootstrap.
      source = 'env';
      preset = 'super_admin';
      permissions = [...PLATFORM_PERMISSIONS];
    } else if (row && row.status === 'active') {
      source = 'db';
      preset = row.preset;
      permissions = row.permissions;
    } else {
      throw notFound(row ? 'platform_admin_disabled_row' : 'platform_admin_not_listed');
    }

    const required = this.reflector.getAllAndOverride<PlatformPermission | undefined>(
      PLATFORM_PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (required && !permissions.includes(required)) throw platformPermissionMissing(required);

    const stepUp = await this.lookup.findLiveStepUp(
      session.userId,
      session.sessionId,
      state.correlationId,
    );
    const exempt = this.reflector.getAllAndOverride<boolean>(STEP_UP_EXEMPT, [
      context.getHandler(),
      context.getClass(),
    ]);
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
      sessionId: session.sessionId,
      stepUp,
      source,
      adminId: row?.id ?? null,
      preset,
      permissions,
      stepUpRemainingSeconds: stepUpRemainingSeconds(stepUp, new Date()),
    });
    return true;
  }
}
