import {
  Controller,
  Get,
  Inject,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { resolveBillingMode } from '../../billing/billing-mode.js';
import { platformCapMicroUsd } from '../../copilot/ai-tiers.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import {
  buildGrowthFigures,
  buildGrowthView,
  growthToCsv,
  parseGrowthQuery,
} from './growth.repository.js';
import type { GrowthRepository, GrowthView } from './growth.repository.js';

export const PLATFORM_GROWTH_REPOSITORY = Symbol.for('tmanage.PlatformGrowthRepository');

/** The one method the CSV needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/**
 * 57-14 Growth (Platform admin · Activity), both `platform.activity.view`, reads only (no audit
 * action — the rows are platform-wide aggregates, no person's or tenant's data):
 * - `GET activity/growth?period=week|month&from&to` — tiles and tables from the nightly rollups;
 * - `GET activity/growth/export.csv` — the same rows as CSV, forced save.
 * 62-A3 (B14): the view also carries `figures` — the success and cost tiles (Figma 758:43241),
 * read from their own periods, with the billing mode and the AI platform ceiling.
 */
@Controller('v1/platform/activity/growth')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformGrowthController {
  /** `AI_PLATFORM_CAP_MAX_USD` (default 100), read once: what the AI credits are shown against. */
  private readonly capMicroUsd = platformCapMicroUsd(process.env);

  constructor(@Inject(PLATFORM_GROWTH_REPOSITORY) private readonly repository: GrowthRepository) {}

  @Get()
  @RequirePlatformPermission('platform.activity.view')
  async growth(
    @Query() raw: { period?: unknown; from?: unknown; to?: unknown },
    @Req() request: object,
  ): Promise<GrowthView> {
    const now = new Date();
    const query = parseGrowthQuery(raw ?? {}, now);
    const { correlationId } = platformRequestContext(request);
    const [rows, inputs, billingMode] = await Promise.all([
      this.repository.rollups(query, correlationId),
      this.repository.figureInputs(correlationId, now),
      resolveBillingMode(),
    ]);
    const figures = buildGrowthFigures(inputs, {
      billingMode,
      platformCapMicroUsd: this.capMicroUsd,
      now,
    });
    return buildGrowthView(query, rows, figures);
  }

  @Get('export.csv')
  @RequirePlatformPermission('platform.activity.view')
  async exportCsv(
    @Query() raw: { period?: unknown; from?: unknown; to?: unknown },
    @Req() request: object,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const query = parseGrowthQuery(raw ?? {}, new Date());
    const rows = await this.repository.rollups(
      query,
      platformRequestContext(request).correlationId,
    );
    const body = Buffer.from(growthToCsv(query.period, rows), 'utf-8');
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-length', String(body.byteLength));
    reply.header(
      'content-disposition',
      `attachment; filename="tmanage-growth-${query.period}-${query.from}-${query.to}.csv"`,
    );
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    return new StreamableFile(body, { type: 'text/csv; charset=utf-8', length: body.byteLength });
  }
}
