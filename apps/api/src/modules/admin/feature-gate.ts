import { Inject, Injectable, SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requireTenantContext } from '../../common/http/request-state.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { PlatformFlagsRepository } from '../platform-admin/settings/flags.repository.js';
import { FeatureFlagsRepository } from './feature-flags.repository.js';
import { resolveFlags } from './feature-flags.service.js';
import type { OptionalModuleFlag } from './feature-flags.service.js';

/**
 * 52-24 — the server side of a rollout flag: one place that says "this route exists only while
 * the organization's flag is on". The flag itself lives in the existing per-org mechanism
 * (`OPTIONAL_MODULE_FLAGS`, x278 + platform PA-10), so the platform owner flips it on the
 * Feature flags screen and the organization's owner on its Modules screen; nothing here stores
 * anything.
 *
 * Off is the calm 404 the copilot already gives (`MESSAGES.notFound`): for this organization the
 * feature does not exist. The gate runs after the global pipeline (session, CSRF, tenant,
 * capability), so it only ever narrows what a caller may reach; it never stands in for a check.
 */

/** The full resolved map for one organization: server lock → platform → org row → code default. */
export async function readResolvedFlags(
  database: TenantDatabase,
  context: TenantContext,
  flags: FeatureFlagsRepository = new FeatureFlagsRepository(),
): Promise<Record<OptionalModuleFlag, boolean>> {
  const rows = await database.read(context, (runner) => flags.list(runner, context));
  // PA-10: without the platform tables (a unit harness, a failed read) the org-only result stands.
  let platform = null;
  if (typeof database.identityRead === 'function') {
    try {
      platform = await new PlatformFlagsRepository(database).contextFor(
        context.organizationId,
        context.correlationId,
      );
    } catch {
      platform = null;
    }
  }
  return resolveFlags(rows, platform);
}

/** The refusal for a feature that is off for this organization. */
export function featureOff(key: OptionalModuleFlag): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, `feature.${key}_off`);
}

/** Throws {@link featureOff} unless `key` resolves on for the context's organization. */
export async function requireFeature(
  database: TenantDatabase,
  context: TenantContext,
  key: OptionalModuleFlag,
): Promise<void> {
  if (!(await readResolvedFlags(database, context))[key]) throw featureOff(key);
}

/** {@link requireFeature} bound to a database, for a public door built outside the Nest pipeline. */
export type FeatureRequirement = (context: TenantContext, key: OptionalModuleFlag) => Promise<void>;

export function featureRequirement(database: TenantDatabase): FeatureRequirement {
  return (context, key) => requireFeature(database, context, key);
}

const REQUIRED_FEATURE = Symbol('tmanage.route.feature');

@Injectable()
export class FeatureGateGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const key = this.reflector.getAllAndOverride<OptionalModuleFlag | undefined>(REQUIRED_FEATURE, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    if (key === undefined) return true;
    await requireFeature(
      this.database,
      requireTenantContext(execution.switchToHttp().getRequest()),
      key,
    );
    return true;
  }
}

/**
 * Put a tenant controller (or one route) behind a rollout flag. Only for tenant-scoped routes:
 * the gate reads the organization from the verified `TenantContext`. Public doors resolve their
 * organization themselves and call {@link requireFeature}.
 */
export const RequireFeature = (key: OptionalModuleFlag): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(REQUIRED_FEATURE, key), UseGuards(FeatureGateGuard));
