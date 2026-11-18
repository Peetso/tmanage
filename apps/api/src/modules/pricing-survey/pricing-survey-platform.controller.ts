import { Controller, Get, Inject, Optional, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import {
  PRICING_SURVEY_BOOTSTRAP_TABLES,
  PRICING_SURVEY_LIST_REASON,
  PricingSurveyRepository,
} from './pricing-survey.repository.js';
import type { PricingAnswerRecord } from './pricing-survey.repository.js';
import { PRICING_BANDS } from './pricing-survey.rules.js';
import type { PricingBand } from './pricing-survey.rules.js';

export interface PlatformPricingAnswerView {
  readonly organizationName: string | null;
  readonly outcome: 'answered' | 'skipped';
  readonly band: PricingBand | null;
  readonly note: string | null;
  readonly answeredAt: string;
}

export interface PlatformPricingSurveyView {
  readonly answered: number;
  readonly skipped: number;
  readonly byBand: readonly { readonly band: PricingBand; readonly count: number }[];
  /** Newest first, at most 200. */
  readonly rows: readonly PlatformPricingAnswerView[];
}

export function buildPlatformPricingSurveyView(
  records: readonly PricingAnswerRecord[],
): PlatformPricingSurveyView {
  const answered = records.filter((record) => record.outcome === 'answered');
  return {
    answered: answered.length,
    skipped: records.length - answered.length,
    byBand: PRICING_BANDS.map((band) => ({
      band,
      count: answered.filter((record) => record.band === band).length,
    })),
    rows: records.map((record) => ({
      organizationName: record.organizationName,
      outcome: record.outcome,
      band: record.band,
      note: record.note,
      answeredAt: record.answeredAt.toISOString(),
    })),
  };
}

/**
 * 57-17 WTP — `GET /v1/platform/pricing-survey`, the Platform admin list of willingness-to-pay
 * answers (Growth page), behind `platform.activity.view`. Read-only, cross-organization through
 * the audited bootstrap path; each row carries the workspace name, never the person.
 */
@Controller('v1/platform/pricing-survey')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformPricingSurveyController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(PricingSurveyRepository)
    private readonly repository: PricingSurveyRepository = new PricingSurveyRepository(),
  ) {}

  @Get()
  @RequirePlatformPermission('platform.activity.view')
  async list(@Req() request: object): Promise<PlatformPricingSurveyView> {
    const records = await this.database.bootstrapRead(
      {
        correlationId: requireRequestState(request).correlationId,
        reason: PRICING_SURVEY_LIST_REASON,
        tables: [...PRICING_SURVEY_BOOTSTRAP_TABLES],
      },
      (runner) => this.repository.listAcrossOrganizations(runner),
    );
    return buildPlatformPricingSurveyView(records);
  }
}
