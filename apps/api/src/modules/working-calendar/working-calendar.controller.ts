import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  CalendarView,
  HolidayView,
  WorkingCalendarService,
} from './working-calendar.service.js';

export const WORKING_CALENDAR_SERVICE = Symbol.for('tmanage.WorkingCalendarService');

/**
 * 53-02 — `/v1/organizations/:orgSlug/working-calendar` (the company calendar and its holidays)
 * and `/v1/organizations/:orgSlug/projects/:projectId/working-calendar` (the effective calendar of
 * a project and its override). Writes on the company calendar need `org.manage`; the project
 * override needs `project.manage` on that project (checked again in the service). No body or query
 * names an organization. No public route.
 */
@Controller('v1/organizations/:orgSlug')
export class WorkingCalendarController {
  constructor(@Inject(WORKING_CALENDAR_SERVICE) private readonly service: WorkingCalendarService) {}

  @Get('working-calendar')
  @RequireCapability('work.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CalendarView> {
    return this.service.getOrg(context, principal);
  }

  @Put('working-calendar')
  @RequireCapability('org.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<CalendarView> {
    return this.service.updateOrg(context, principal, body);
  }

  @Post('working-calendar/holidays')
  @RequireCapability('org.manage')
  @HttpCode(201)
  addHoliday(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<HolidayView> {
    return this.service.addHoliday(context, principal, body);
  }

  @Delete('working-calendar/holidays/:holidayId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async deleteHoliday(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('holidayId') holidayId: string,
  ): Promise<void> {
    await this.service.deleteHoliday(context, principal, holidayId);
  }

  @Post('working-calendar/import-pack')
  @RequireCapability('org.manage')
  @HttpCode(200)
  importPack(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<CalendarView> {
    return this.service.importPack(context, principal, body);
  }

  @Get('projects/:projectId/working-calendar')
  @RequireCapability('work.read')
  getProject(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<CalendarView> {
    return this.service.getProject(context, principal, projectId);
  }

  @Put('projects/:projectId/working-calendar')
  @RequireCapability('project.manage')
  updateProject(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<CalendarView> {
    return this.service.updateProject(context, principal, projectId, body);
  }

  @Delete('projects/:projectId/working-calendar')
  @RequireCapability('project.manage')
  deleteProject(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<CalendarView> {
    return this.service.deleteProject(context, principal, projectId);
  }
}
