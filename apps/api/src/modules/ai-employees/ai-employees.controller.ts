import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  AiEmployeeListView,
  AiEmployeeView,
  AiEmployeesService,
} from './ai-employees.service.js';

export const AI_EMPLOYEES_SERVICE = Symbol.for('tmanage.AiEmployeesService');

/**
 * 60-03 (plan 60 v2 §2.1, §4.1) — AI employees, `/v1/organizations/:orgSlug/ai-employees`. Every
 * route is a person's cookie session only (`requirePersonSession`) and NEVER in the AI registry
 * (`ai_employee_admin`):
 *
 * - `GET ''`, `GET :aiEmployeeId` (`people.view`): the workspace's AI employees with sponsor,
 *   status, hours, limits and the caller's `can*` decisions.
 * - `POST ''` (`ai_employee.manage`): hire (a credential-less user, a member of kind `ai`, the
 *   companion row, one transaction).
 * - `PATCH :aiEmployeeId`, `POST :aiEmployeeId/pause|resume|sponsor|retire`
 *   (`ai_employee.manage`): each carries the `version` it read (409 when stale).
 */
@Controller('v1/organizations/:orgSlug/ai-employees')
export class AiEmployeesController {
  constructor(@Inject(AI_EMPLOYEES_SERVICE) private readonly service: AiEmployeesService) {}

  @Get()
  @RequireCapability('people.view')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiEmployeeListView> {
    return this.service.list(context, principal);
  }

  @Get(':aiEmployeeId')
  @RequireCapability('people.view')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
  ): Promise<AiEmployeeView> {
    return this.service.get(context, principal, aiEmployeeId);
  }

  @Post()
  @RequireCapability('ai_employee.manage')
  hire(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<AiEmployeeView> {
    return this.service.hire(context, principal, body);
  }

  @Patch(':aiEmployeeId')
  @RequireCapability('ai_employee.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Body() body: unknown,
  ): Promise<AiEmployeeView> {
    return this.service.update(context, principal, aiEmployeeId, body);
  }

  @Post(':aiEmployeeId/pause')
  @HttpCode(200)
  @RequireCapability('ai_employee.manage')
  pause(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Body() body: unknown,
  ): Promise<AiEmployeeView> {
    return this.service.pause(context, principal, aiEmployeeId, body);
  }

  @Post(':aiEmployeeId/resume')
  @HttpCode(200)
  @RequireCapability('ai_employee.manage')
  resume(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Body() body: unknown,
  ): Promise<AiEmployeeView> {
    return this.service.resume(context, principal, aiEmployeeId, body);
  }

  @Post(':aiEmployeeId/sponsor')
  @HttpCode(200)
  @RequireCapability('ai_employee.manage')
  changeSponsor(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Body() body: unknown,
  ): Promise<AiEmployeeView> {
    return this.service.changeSponsor(context, principal, aiEmployeeId, body);
  }

  @Post(':aiEmployeeId/retire')
  @HttpCode(200)
  @RequireCapability('ai_employee.manage')
  retire(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Body() body: unknown,
  ): Promise<AiEmployeeView> {
    return this.service.retire(context, principal, aiEmployeeId, body);
  }
}
