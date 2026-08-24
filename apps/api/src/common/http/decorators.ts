import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Capability, Principal } from '@tmanage/domain';
import type { TenantContext } from '../database/tenant-context.js';
import { requirePrincipal, requireSession, requireTenantContext } from './request-state.js';
import type { AuthenticatedSession } from '../../modules/identity/session.service.js';

/**
 * Route metadata and parameter accessors.
 *
 * The guards are registered globally, so the default for any new route is the full pipeline:
 * authenticated, CSRF-checked, tenant-resolved. These decorators are how a route opts *out*,
 * which is the direction that makes a forgotten annotation safe — a new endpoint that nobody
 * remembered to protect is protected.
 */

export const IS_PUBLIC = Symbol('tmanage.route.public');
export const SKIPS_TENANT = Symbol('tmanage.route.noTenant');
export const REQUIRED_CAPABILITY = Symbol('tmanage.route.capability');

/**
 * No session required. Sign-in and health checks only.
 *
 * Also skips CSRF, and that is sound rather than convenient: the CSRF token is bound to a
 * session id, so a route reached without a session has no token to bind to. What protects a
 * public mutation is that it establishes authority rather than exercising it.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Authenticated, CSRF-checked, but not bound to an organization.
 *
 * For the handful of routes that are genuinely about the person rather than about a tenant:
 * the device/session list, sign-out, refresh.
 */
export const NoTenant = (): MethodDecorator & ClassDecorator => SetMetadata(SKIPS_TENANT, true);

/**
 * The capability `authorize()` is asked for — spec §3 step 5.
 *
 * A tenant-scoped route without this annotation is refused by `CapabilityGuard` rather than
 * allowed. An endpoint whose author did not say what it needs is not an endpoint that needs
 * nothing.
 */
export const RequireCapability = (capability: Capability): MethodDecorator =>
  SetMetadata(REQUIRED_CAPABILITY, capability);

/** The verified `TenantContext`. Throws if the guard did not run — see `request-state.ts`. */
export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext =>
    requireTenantContext(context.switchToHttp().getRequest()),
);

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal =>
    requirePrincipal(context.switchToHttp().getRequest()),
);

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedSession =>
    requireSession(context.switchToHttp().getRequest()),
);
