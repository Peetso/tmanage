import { Controller, Get, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { NoTenant } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import type {
  ProductEventsScoreboardView,
  ProductEventsService,
} from './product-events.service.js';

export const EASE_SCOREBOARD_SERVICE = Symbol.for('tmanage.EaseScoreboardService');

/**
 * 55-21 — `GET /v1/platform/ease-scoreboard?weeks=8`, the Platform admin "Ease scoreboard" data
 * (the screen waits for Figma `55/MEAS-01`). Cross-organization by nature, so it is a platform
 * route behind `platform.activity.view` (the plan's permission), and it answers aggregates only:
 * weekly counts by event, locale and audience, and timer buckets — groups under the k-anonymity
 * floor are withheld, and no organization id, actor hash or property blob leaves the database.
 */
@Controller('v1/platform')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class EaseScoreboardController {
  constructor(@Inject(EASE_SCOREBOARD_SERVICE) private readonly service: ProductEventsService) {}

  @Get('ease-scoreboard')
  @RequirePlatformPermission('platform.activity.view')
  scoreboard(
    @Req() request: object,
    @Query('weeks') weeks: unknown,
  ): Promise<ProductEventsScoreboardView> {
    return this.service.scoreboard(requireRequestState(request).correlationId, weeks);
  }
}
