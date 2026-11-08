import { Body, Controller, Get, HttpCode, Inject, Optional, Param, Post } from '@nestjs/common';
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
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import {
  WIZARD_STEPS,
  dismissWizard,
  isWizardOutcome,
  isWizardStep,
  parseWizardState,
  recordStep,
  resumeStep,
  serializeWizardState,
} from './onboarding-wizard.state.js';
import type {
  WizardOutcome,
  WizardState,
  WizardStatus,
  WizardStep,
} from './onboarding-wizard.state.js';

/** The wizard as the screen reads it: status, where to resume, and every step's outcome. */
export interface OnboardingWizardView {
  readonly status: WizardStatus;
  readonly currentStep: WizardStep;
  readonly steps: readonly {
    readonly step: WizardStep;
    readonly outcome: WizardOutcome | null;
  }[];
}

interface RecordStepBody {
  readonly outcome?: unknown;
}

const SETTING_KEY = 'onboarding_wizard';

/**
 * 55-01 / 55-01a / 55-03 — the onboarding wizard's resumable state, one per company.
 *
 * Behind `org.manage` (the coarse gate) plus the real org-wide `authorize`, the same pair the
 * settings routes use: the wizard sets the company's name, logo, work type and storage, all
 * `org.manage` actions. The state lives in the `onboarding_wizard` settings row; the steps' own
 * effects (rename, invitations, storage connect, template packs) go through their existing routes.
 * The step and outcome are validated before any write; an unknown one is a 400 with no write.
 */
@Controller('v1/organizations/:orgSlug/onboarding/wizard')
export class OnboardingWizardController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(OrgSettingsRepository)
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
  ) {}

  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OnboardingWizardView> {
    this.requireOrgManage(principal, context);
    const state = await this.database.read(context, (runner) => this.load(runner, context));
    return toView(state);
  }

  /** Record a step as done or skipped (200 — the wizard after the write). */
  @Post('steps/:step')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async record(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('step') step: string,
    @Body() body: RecordStepBody,
  ): Promise<OnboardingWizardView> {
    this.requireOrgManage(principal, context);
    if (!isWizardStep(step)) {
      throw invalid('step', `must be one of ${WIZARD_STEPS.join(', ')}`);
    }
    const outcome = body?.outcome;
    if (!isWizardOutcome(outcome)) throw invalid('outcome', 'must be done or skipped');
    return this.update(context, principal, (state) => {
      const next = recordStep(state, step, outcome);
      if ('error' in next) throw invalid('outcome', 'Finish cannot be skipped');
      return next;
    });
  }

  /** "Skip setup" — leave the wizard; a later visit resumes where it was (200). */
  @Post('dismiss')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async dismiss(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OnboardingWizardView> {
    this.requireOrgManage(principal, context);
    return this.update(context, principal, dismissWizard);
  }

  private async update(
    context: TenantContext,
    principal: Principal,
    change: (state: WizardState) => WizardState,
  ): Promise<OnboardingWizardView> {
    const next = await this.database.transaction(context, async (tx) => {
      const org = await this.settings.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const state = change(await this.load(tx, context));
      await this.settings.upsert(tx, context, {
        key: SETTING_KEY,
        value: serializeWizardState(state),
        updatedBy: principal.userId,
      });
      return state;
    });
    return toView(next);
  }

  private async load(runner: TenantQueryRunner, context: TenantContext): Promise<WizardState> {
    const row = await this.settings.findByKey(runner, context, SETTING_KEY);
    return parseWizardState(row?.settingValue);
  }

  private requireOrgManage(principal: Principal, context: TenantContext): void {
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
        `onboarding_wizard:${verdict.code}`,
      );
    }
  }
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

export function toView(state: WizardState): OnboardingWizardView {
  return {
    status: state.status,
    currentStep: resumeStep(state),
    steps: WIZARD_STEPS.map((step) => ({ step, outcome: state.outcomes[step] ?? null })),
  };
}
