import { Controller, Get, HttpCode, Inject, Optional, Param, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { GettingStartedRepository } from './getting-started.repository.js';
import {
  CHECKLIST_STEPS,
  isChecklistStep,
  markStep,
  projectChecklist,
  projectSetupHealth,
} from './getting-started.steps.js';
import type {
  GettingStartedView,
  SetupHealthView,
  StoredChecklist,
} from './getting-started.steps.js';

export type { GettingStartedView, SetupHealthView } from './getting-started.steps.js';

/**
 * 55-11 getting-started checklist and 55-22 Setup health.
 *
 * The checklist routes sit behind `work.read` (every internal member has it; a client principal is
 * refused by `CapabilityGuard`) and are always the acting member's own: no route reads a membership
 * id from input. `:step` is validated before any write (unknown → 400, nothing stored); marking and
 * dismissing are idempotent. Setup health is the owner's view, behind `org.manage` checked again
 * with the real `authorize` in the handler.
 */
@Controller('v1/organizations/:orgSlug/getting-started')
export class GettingStartedController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(GettingStartedRepository)
    private readonly repository: GettingStartedRepository = new GettingStartedRepository(),
  ) {}

  @Get()
  @RequireCapability('work.read')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<GettingStartedView> {
    return this.database.read(context, (runner) => this.view(runner, context));
  }

  /** Mark one step done by hand (200 — the checklist after). */
  @Post('steps/:step/complete')
  @RequireCapability('work.read')
  @HttpCode(200)
  async complete(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('step') step: string,
  ): Promise<GettingStartedView> {
    if (!isChecklistStep(step)) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'step', message: `must be one of ${CHECKLIST_STEPS.join(', ')}` },
      ]);
    }
    return this.update(context, (stored) => markStep(stored, step));
  }

  /** Hide the checklist for this member (200). Dismissing twice keeps the first time. */
  @Post('dismiss')
  @RequireCapability('work.read')
  @HttpCode(200)
  async dismiss(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<GettingStartedView> {
    return this.update(context, (stored) =>
      stored.dismissedAt !== null ? stored : { ...stored, dismissedAt: new Date().toISOString() },
    );
  }

  /** The owner's Setup health: four checks with ok flags (the screen owns the fix links). */
  @Get('setup-health')
  @RequireCapability('org.manage')
  async health(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SetupHealthView> {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `setup_health:${verdict.code}`,
      );
    }
    const signals = await this.database.read(context, (runner) =>
      this.repository.readHealth(runner, context),
    );
    return projectSetupHealth(signals);
  }

  private async update(
    context: TenantContext,
    change: (stored: StoredChecklist) => StoredChecklist,
  ): Promise<GettingStartedView> {
    return this.database.transaction(context, async (tx) => {
      const stored = await this.repository.readStored(tx, context, context.membershipId);
      const next = change(stored);
      if (next !== stored) {
        await this.repository.writeStored(tx, context, context.membershipId, next);
      }
      const signals = await this.repository.readSignals(tx, context);
      return projectChecklist(signals, next);
    });
  }

  private async view(runner: TenantQueryRunner, context: TenantContext) {
    const [stored, signals] = [
      await this.repository.readStored(runner, context, context.membershipId),
      await this.repository.readSignals(runner, context),
    ];
    return projectChecklist(signals, stored);
  }
}
