import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { requireRequestState } from '../../../common/http/request-state.js';
import { NETWORK_ACCESS_SERVICE } from './network-access.service.js';
import type { NetworkAccessService } from './network-access.service.js';

/**
 * SEC-ALERTS item 7 — the sign-in door. A global guard that acts on the routes that let a person
 * in or create an account (below) and on nothing else; every other route passes untouched.
 *
 * Already signed-in sessions are not refused in v1 (decided; follow-up in the lane report): the
 * door stops a VPN at the moment of signing in, signing up, resetting a password or starting a
 * Google or Microsoft sign-in, not in the middle of someone's work.
 *
 * The routes, as `METHOD controller/handler` exactly as the controllers declare them (the
 * `SESSION_ESTABLISHING_ROUTES` convention of `csrf.guard.ts`). The OAuth callbacks are not on
 * the list: they need the state their `start` set, and `start` is refused. The MFA and recovery
 * steps are not either: they need the half-session the gated password step created.
 */
export const NETWORK_GATED_ROUTES: ReadonlySet<string> = new Set([
  'POST v1/auth/password',
  'POST v1/auth/passkey',
  'POST v1/auth/google/start',
  'POST v1/auth/microsoft/start',
  'POST v1/public/sign-up',
  'POST v1/invitations/registrations',
  'POST v1/password-resets',
  'POST v1/password-resets/completions',
  'POST v1/public/portal-sign-in',
  'POST v1/public/portal-sign-in/code',
  'POST v1/public/portal-sign-in/links/:token/consume',
]);

/** Nest's route-path metadata key (`@nestjs/common/constants` PATH_METADATA). */
const PATH_METADATA = 'path';

function declaredPath(value: unknown): string {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
  return typeof raw === 'string' ? raw.replace(/^\/+|\/+$/g, '') : '';
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name];
  return typeof value === 'string' && value.length <= 128 ? value : null;
}

@Injectable()
export class NetworkAccessGuard implements CanActivate {
  private service: NetworkAccessService | null | undefined;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  /** The service, looked up once and not strictly: a test app without the module passes all. */
  private resolve(): NetworkAccessService | null {
    if (this.service === undefined) {
      try {
        this.service = this.moduleRef.get<NetworkAccessService>(NETWORK_ACCESS_SERVICE, {
          strict: false,
        });
      } catch {
        this.service = null;
      }
    }
    return this.service;
  }

  routeOf(context: ExecutionContext, method: string): string {
    const base = declaredPath(this.reflector.get<unknown>(PATH_METADATA, context.getClass()));
    const sub = declaredPath(this.reflector.get<unknown>(PATH_METADATA, context.getHandler()));
    return `${method.toUpperCase()} ${[base, sub].filter((p) => p !== '').join('/')}`;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<{
      readonly method: string;
      readonly ip?: string;
      readonly headers: Record<string, string | string[] | undefined>;
      readonly body?: unknown;
    }>();
    if (!NETWORK_GATED_ROUTES.has(this.routeOf(context, request.method))) return true;
    const service = this.resolve();
    if (service === null) return true;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = typeof body['email'] === 'string' ? body['email'] : null;
    await service.enforce({
      ip: request.ip ?? null,
      userAgent: header(request.headers, 'user-agent'),
      clientTimeZone: header(request.headers, 'x-client-time-zone'),
      clientLanguage: header(request.headers, 'x-client-language'),
      email,
      correlationId: requireRequestState(request).correlationId,
    });
    return true;
  }
}
