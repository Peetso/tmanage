import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TIME_MANAGE_ANY, TIME_TRACK_OWN } from './time-capabilities.js';
import type { TeamWeekView, TimesheetsService, TimesheetView } from './timesheets.service.js';

export const TIMESHEETS_SERVICE = Symbol.for('tmanage.TimesheetsService');

/** The one method the download needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/**
 * 52-02 / 52-03 — `/v1/organizations/:orgSlug/time/timesheets`.
 *
 * Capability stand-ins (all in `time-capabilities.ts`; no `capabilities.ts` edit this slice): the
 * plan's `time.track_own` is {@link TIME_TRACK_OWN} (`work.read`) plus `requireInternal` in the
 * service; `time.view_team`, `time.edit_any` and `time.approve` are all {@link TIME_MANAGE_ANY}
 * (`project.manage`), asked again per project in the service. The batch edit, the move and the copy
 * stand on track-own here because a member edits their own week; the service lets a manager edit
 * somebody else's only when they hold TIME_MANAGE_ANY. Org-internal: no portal or public route.
 */
@Controller('v1/organizations/:orgSlug/time/timesheets')
export class TimesheetsController {
  constructor(@Inject(TIMESHEETS_SERVICE) private readonly service: TimesheetsService) {}

  @Get('mine')
  @RequireCapability(TIME_TRACK_OWN)
  mine(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('week') week?: string,
  ): Promise<TimesheetView> {
    return this.service.mine(context, principal, week);
  }

  @Get()
  @RequireCapability(TIME_MANAGE_ANY)
  team(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('week') week?: string,
    @Query('membershipId') membershipId?: string,
  ): Promise<TeamWeekView> {
    return this.service.team(context, principal, week, membershipId);
  }

  @Put(':timesheetId/entries')
  @RequireCapability(TIME_TRACK_OWN)
  @HttpCode(200)
  upsert(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
    @Body() body: unknown,
  ): Promise<TimesheetView> {
    return this.service.upsertEntries(context, principal, timesheetId, body);
  }

  @Post(':timesheetId/entries/move')
  @RequireCapability(TIME_TRACK_OWN)
  @HttpCode(200)
  move(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
    @Body() body: unknown,
  ): Promise<TimesheetView> {
    return this.service.move(context, principal, timesheetId, body);
  }

  @Post(':timesheetId/entries/split')
  @RequireCapability(TIME_TRACK_OWN)
  @HttpCode(200)
  split(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
    @Body() body: unknown,
  ): Promise<TimesheetView> {
    return this.service.split(context, principal, timesheetId, body);
  }

  @Post(':timesheetId/entries/delete')
  @RequireCapability(TIME_TRACK_OWN)
  @HttpCode(200)
  deleteUnassigned(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
    @Body() body: unknown,
  ): Promise<TimesheetView> {
    return this.service.deleteUnassigned(context, principal, timesheetId, body);
  }

  @Post(':timesheetId/submit')
  @RequireCapability(TIME_TRACK_OWN)
  @HttpCode(200)
  submit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
  ): Promise<TimesheetView> {
    return this.service.submit(context, principal, timesheetId);
  }

  @Post(':timesheetId/approve')
  @RequireCapability(TIME_MANAGE_ANY)
  @HttpCode(200)
  approve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
  ): Promise<TimesheetView> {
    return this.service.decide(context, principal, timesheetId, {}, true);
  }

  @Post(':timesheetId/request-changes')
  @RequireCapability(TIME_MANAGE_ANY)
  @HttpCode(200)
  requestChanges(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
    @Body() body: unknown,
  ): Promise<TimesheetView> {
    return this.service.decide(context, principal, timesheetId, body, false);
  }

  @Post(':timesheetId/copy-from')
  @RequireCapability(TIME_TRACK_OWN)
  @HttpCode(200)
  copyFrom(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
    @Body() body: unknown,
  ): Promise<TimesheetView> {
    return this.service.copyFrom(context, principal, timesheetId, body);
  }

  @Get(':timesheetId/export.csv')
  @RequireCapability(TIME_MANAGE_ANY)
  async exportCsv(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('timesheetId') timesheetId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const csv = await this.service.exportCsv(context, principal, timesheetId);
    const body = Buffer.from(csv.body, 'utf8');
    reply.header('content-type', CSV_CONTENT_TYPE);
    reply.header('content-length', String(body.byteLength));
    reply.header('content-disposition', `attachment; filename="${csv.filename}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(body, { type: CSV_CONTENT_TYPE, length: body.byteLength });
  }
}
