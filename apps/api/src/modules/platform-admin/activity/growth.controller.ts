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
import { platformRequestContext } from '../platform-admin.access.js';
import { PlatformAdminGuard } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { buildGrowthView, growthToCsv, parseGrowthQuery } from './growth.repository.js';
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
 * The Figma Growth view does not exist yet; these routes and the monthly mail are the surface.
 */
@Controller('v1/platform/activity/growth')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformGrowthController {
  constructor(@Inject(PLATFORM_GROWTH_REPOSITORY) private readonly repository: GrowthRepository) {}

  @Get()
  @RequirePlatformPermission('platform.activity.view')
  async growth(
    @Query() raw: { period?: unknown; from?: unknown; to?: unknown },
    @Req() request: object,
  ): Promise<GrowthView> {
    const query = parseGrowthQuery(raw ?? {}, new Date());
    const rows = await this.repository.rollups(
      query,
      platformRequestContext(request).correlationId,
    );
    return buildGrowthView(query, rows);
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
