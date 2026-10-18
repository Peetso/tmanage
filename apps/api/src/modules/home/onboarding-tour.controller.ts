import { Controller, Get, HttpCode, Inject, Optional, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { OnboardingTourStep } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { OnboardingTourRepository } from './onboarding-tour.repository.js';
import { ONBOARDING_TOUR, isOnboardingTourStep } from './onboarding-tour.steps.js';

/**
 * ON-10 guided-tour progress (x155) — the CONTRACT-001 response projection.
 *
 * The whole fixed tour, in presentation order, each step carrying the acting member's completed flag
 * (default false). One shape rather than a `steps: string[]` plus a separate completed set, so the
 * screen renders the checklist from a single response and the API↔web pairing is this one `View`.
 * Dates are ISO strings, the shape `JSON.stringify` emits on the wire; `completedAt` is null for a
 * step the member has not finished.
 */
export interface OnboardingTourView {
  readonly steps: readonly {
    readonly step: OnboardingTourStep;
    readonly label: string;
    readonly completed: boolean;
    readonly completedAt: string | null;
  }[];
}

/**
 * ON-10 guided-tour progress — track an acting member's completion of the fixed tour steps.
 *
 * ## Scope and safety
 *
 * Both routes sit behind `work.read` — the capability every Home read uses, reused rather than a new
 * `onboarding.read` so this slice stays off `capabilities.ts` and the role grid (a caller without it,
 * e.g. a client principal, is refused 403 by `CapabilityGuard` before any handler runs). Neither
 * route reads an `organizationId` or a `membershipId` from anywhere: the tenant and the acting
 * membership are `TenantContextGuard`'s, and progress is always the acting member's own — so one
 * member can never read or advance another's tour (own-principal substance).
 *
 * The completion route validates `:step` against the fixed step set BEFORE resolving the acting
 * membership and writing (the Known trap): an unknown step is a 400 with no write, never a 500 or a
 * stored junk value. Completion is idempotent — re-completing a step the member already finished is a
 * 200 with the same progress and no duplicate row (the unique step key made concrete). The
 * orchestration lives in the controller because it is small and the safety is two rules a controller
 * test proves directly with the real `authorize`.
 */
@Controller('v1/organizations/:orgSlug/onboarding/tour')
export class OnboardingTourController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(OnboardingTourRepository)
    private readonly progress: OnboardingTourRepository = new OnboardingTourRepository(),
  ) {}

  /** The fixed tour with the acting member's completed flags, defaults false (200). */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<OnboardingTourView> {
    return this.listOwn(context);
  }

  /**
   * Mark a tour step complete for the acting member and return the tour after (200 — completion is
   * idempotent, so nothing may have been created). `:step` is validated against the fixed step set
   * before any write (Known trap): an unknown step is a 400. Re-completing an already-finished step
   * writes nothing and answers 200.
   */
  @Post(':step/complete')
  @RequireCapability('work.read')
  @HttpCode(200)
  async complete(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('step') step: string,
  ): Promise<OnboardingTourView> {
    // Validate the step BEFORE resolving the membership or writing (Known trap): unknown → 400.
    if (!isOnboardingTourStep(step)) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        {
          field: 'step',
          message: `must be one of ${ONBOARDING_TOUR.map((entry) => entry.step).join(', ')}`,
        },
      ]);
    }

    // Own-membership write: the acting membership is the tenant context's, never from input, so a
    // member only ever advances their own tour. Idempotent — a re-complete writes nothing.
    await this.database.transaction(context, (tx) =>
      this.progress.complete(tx, context, context.membershipId, step),
    );

    return this.listOwn(context);
  }

  /** The fixed tour projected against the acting membership's completed steps. */
  private async listOwn(context: TenantContext): Promise<OnboardingTourView> {
    const rows = await this.database.read(context, (runner) =>
      this.progress.listForMembership(runner, context, context.membershipId),
    );
    const completedAt = new Map(rows.map((row) => [row.step, row.completedAt]));
    return {
      steps: ONBOARDING_TOUR.map((entry) => {
        const when = completedAt.get(entry.step);
        return {
          step: entry.step,
          label: entry.label,
          completed: when !== undefined,
          completedAt: when !== undefined ? when.toISOString() : null,
        };
      }),
    };
  }
}
