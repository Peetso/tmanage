import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { OFFBOARDING_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  MemberOffboardingImpactView,
  OffboardedMemberView,
  OffboardingService,
} from './offboarding.service.js';

/**
 * ADM-12/13 (x121) — member offboarding, behind `member.offboard`.
 *
 * A separate controller from `MembersController` on purpose: that one is the read-only `work.read`
 * directory every member uses to file work, and this is the Administration write boundary that
 * revokes a member's access. Sharing the `members` prefix keeps the URLs where a caller expects a
 * membership's sub-resources to be; keeping the classes apart keeps the capability that guards
 * each one visible at the top of the file that owns it.
 *
 * Like every tenant-scoped controller, it never reads `organizationId` from the body, a header, or
 * its own `:orgSlug` segment: it passes on the `TenantContext` the guard built. The member's user
 * id is the only input, in the path, and the service resolves it tenant-scoped before any write.
 * User id rather than membership id because the member directory (D16) is what drives the picker
 * and it projects `userId`, never `membershipId`; `(organization_id, user_id)` is a unique key, so
 * the resolution is as single-valued and tenant-scoped as a by-id lookup.
 */
@Controller('v1/organizations/:orgSlug/members')
export class OffboardingController {
  constructor(@Inject(OFFBOARDING_SERVICE) private readonly offboarding: OffboardingService) {}

  /**
   * ADM-12 — the access-impact preview. Read-only: the access and work a member holds, so the
   * decision to offboard is taken with its consequences in view. An unknown or cross-tenant user id
   * is a 404, never an empty preview that would confirm the member exists.
   */
  @Get(':userId/offboarding-impact')
  @RequireCapability('member.offboard')
  async impact(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
  ): Promise<MemberOffboardingImpactView> {
    if (typeof userId !== 'string' || userId === '') {
      throw new ApiError(400, 'validation_failed', 'userId is required', [
        { field: 'userId', message: 'must be a non-empty string' },
      ]);
    }
    return this.offboarding.impact(context, principal, userId);
  }

  /**
   * ADM-13 — offboard a member. The service resolves the membership tenant-scoped before any write,
   * refuses the three ways an offboard can be a mistake (self, last administrator, already
   * terminal) with no write, and commits the status transition and the audit row together.
   */
  @Post(':userId/offboard')
  @RequireCapability('member.offboard')
  @HttpCode(200)
  async offboard(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
  ): Promise<OffboardedMemberView> {
    if (typeof userId !== 'string' || userId === '') {
      throw new ApiError(400, 'validation_failed', 'userId is required', [
        { field: 'userId', message: 'must be a non-empty string' },
      ]);
    }
    return this.offboarding.offboard(context, principal, userId);
  }
}
