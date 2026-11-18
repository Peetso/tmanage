import { Body, Controller, Get, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PricingSurveyRepository, isDuplicateAnswer } from './pricing-survey.repository.js';
import type { PricingSurveyState } from './pricing-survey.repository.js';
import {
  mayAnswerPricingSurvey,
  parsePricingAnswer,
  workspaceOldEnough,
} from './pricing-survey.rules.js';
import type { PricingBand, PricingSurveyOutcome } from './pricing-survey.rules.js';

/** What the Home card needs: show it or not. Never says why (no role or age leaks). */
export interface PricingSurveyView {
  readonly show: boolean;
}

/** The answer's receipt: the card turns into its "Sent" state (or disappears on a skip). */
export interface PricingSurveyResultView {
  readonly show: false;
  readonly outcome: PricingSurveyOutcome;
}

/**
 * 57-17 WTP — the willingness-to-pay card on Home.
 *
 * Behind `work.read` (every internal member has it; a client principal is refused by the
 * capability guard), then checked again here, server-side, on every route:
 * - role: owner, org admin or workspace admin only ({@link mayAnswerPricingSurvey});
 * - age: the workspace is at least 14 days old;
 * - once: one answer or skip per person per workspace — read first, and the unique key
 *   `(organization_id, membership_id)` refuses a racing second insert (409);
 * - the note is at most 500 characters.
 * The membership is always the session's; no route reads a person or a workspace from input.
 */
@Controller('v1/organizations/:orgSlug/pricing-survey')
export class PricingSurveyController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(PricingSurveyRepository)
    private readonly repository: PricingSurveyRepository = new PricingSurveyRepository(),
    @Optional()
    @Inject('PRICING_SURVEY_CLOCK')
    private readonly now: () => Date = () => new Date(),
  ) {}

  @Get()
  @RequireCapability('work.read')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PricingSurveyView> {
    if (!mayAnswerPricingSurvey(principal)) return { show: false };
    const state = await this.database.read(context, (runner) =>
      this.repository.readState(runner, context),
    );
    return { show: this.open(state) };
  }

  /** Send an answer: a band and an optional note (200). */
  @Post('answer')
  @RequireCapability('work.read')
  @HttpCode(200)
  async answer(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<PricingSurveyResultView> {
    this.requireRole(principal);
    const input = parsePricingAnswer(body);
    return this.record(context, 'answered', input.band, input.note);
  }

  /** Skip: never asked again (200). */
  @Post('skip')
  @RequireCapability('work.read')
  @HttpCode(200)
  async skip(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PricingSurveyResultView> {
    this.requireRole(principal);
    return this.record(context, 'skipped', null, null);
  }

  private requireRole(principal: Principal): void {
    if (!mayAnswerPricingSurvey(principal)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'pricing_survey:role');
    }
  }

  private open(state: PricingSurveyState): boolean {
    return !state.alreadyResponded && workspaceOldEnough(state.workspaceCreatedAt, this.now());
  }

  private async record(
    context: TenantContext,
    outcome: PricingSurveyOutcome,
    band: PricingBand | null,
    note: string | null,
  ): Promise<PricingSurveyResultView> {
    try {
      await this.database.transaction(context, async (tx) => {
        const state = await this.repository.readState(tx, context);
        if (state.alreadyResponded) throw alreadyAnswered();
        if (!workspaceOldEnough(state.workspaceCreatedAt, this.now())) {
          throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'pricing_survey:age');
        }
        await this.repository.insert(tx, context, {
          outcome,
          band,
          note,
          answeredAt: this.now(),
        });
      });
    } catch (error) {
      if (isDuplicateAnswer(error)) throw alreadyAnswered();
      throw error;
    }
    return { show: false, outcome };
  }
}

function alreadyAnswered(): ApiError {
  return new ApiError(409, 'conflict', 'You have already answered this question.');
}
