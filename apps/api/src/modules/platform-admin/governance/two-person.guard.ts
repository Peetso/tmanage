import { Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../../common/http/tokens.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { platformActorOf } from '../platform-admin.guard.js';
import { GovernanceRepository } from './governance.repository.js';
import { PlatformGovernanceService } from './governance.service.js';
import type { RiskyPlatformAction } from './governance.service.js';

/** The route metadata key of {@link RequireTwoPersonApproval} (read by the ADR-0015 census test). */
export const TWO_PERSON_ACTION = Symbol('tmanage.route.twoPersonAction');

/** Marks a risky platform route. Use beside `@UseGuards(TwoPersonApprovalGuard)`. */
export const RequireTwoPersonApproval = (action: RiskyPlatformAction): MethodDecorator =>
  SetMetadata(TWO_PERSON_ACTION, action);

/**
 * 56-21 — runs after `PlatformAdminGuard` (class guards run first) on a risky route. While the
 * two-person policy is on, the body must carry `approvalId` of an approval another admin gave for
 * this action on this `:organizationId`; it is consumed here. Policy off: a no-op.
 */
@Injectable()
export class TwoPersonApprovalGuard implements CanActivate {
  private readonly service: PlatformGovernanceService;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TENANT_DATABASE) database: TenantDatabase,
  ) {
    this.service = new PlatformGovernanceService(new GovernanceRepository(database), null);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<RiskyPlatformAction | undefined>(
      TWO_PERSON_ACTION,
      context.getHandler(),
    );
    if (action === undefined) return true;
    const request = context.switchToHttp().getRequest<{
      params?: Record<string, unknown>;
      body?: unknown;
    }>();
    const actor = platformActorOf(request);
    if (!actor)
      throw new Error('TwoPersonApprovalGuard used on a route without PlatformAdminGuard');
    const targetId = String(request.params?.['organizationId'] ?? '').toLowerCase();
    const body = (request.body ?? {}) as Record<string, unknown>;
    await this.service.requireApproval(
      actor,
      action,
      targetId,
      body['approvalId'],
      platformRequestContext(request),
    );
    return true;
  }
}
