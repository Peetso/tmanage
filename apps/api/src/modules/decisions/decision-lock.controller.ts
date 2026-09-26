import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DECISIONS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DecisionLockView, DecisionsService } from './decisions.service.js';

/**
 * SEC / Decisions (x150). The decision-lock endpoint: seal a decided record against every further
 * lifecycle write.
 *
 * Gated on `meeting.write` — the register reuses the calendar's capabilities (no dedicated
 * `decision.*`; a Needs-Peter), exactly as `DecisionsController` does. Like every tenant-scoped
 * controller here, it never reads `organizationId` from the body, a header, or its own `:orgSlug`
 * segment: it receives the `TenantContext` that `TenantContextGuard` built from a membership row and
 * passes it on. It is a separate controller from `DecisionsController` on the same base path — the
 * `:decisionId/lock` sub-path is distinct from that controller's routes — so the lock surface is its
 * own file, and the tenant/relation resolution, the not-found for an unknown/cross-tenant/non-member
 * id, and the re-lock 409 are all the service's.
 */
@Controller('v1/organizations/:orgSlug/decisions')
export class DecisionLockController {
  constructor(@Inject(DECISIONS_SERVICE) private readonly decisions: DecisionsService) {}

  @Post(':decisionId/lock')
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async lock(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
  ): Promise<DecisionLockView> {
    if (typeof decisionId !== 'string' || decisionId === '') {
      throw new ApiError(400, 'validation_failed', 'decisionId is required', [
        { field: 'decisionId', message: 'must be a non-empty string' },
      ]);
    }
    return this.decisions.lock(context, principal, decisionId);
  }
}
