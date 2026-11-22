import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { CreatedAgentKeyView } from '../personal-access-tokens/agent-keys.js';
import type {
  AgentKeyListView,
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
 * - 60-05 `GET|POST :aiEmployeeId/keys`, `POST :aiEmployeeId/keys/:keyId/rotate`,
 *   `DELETE :aiEmployeeId/keys/:keyId`: agent keys. The guard asks `people.view`; the service
 *   decides "who may bind" (the sponsor, or a holder of `ai_employee.manage`), because a sponsor
 *   need not hold the manage capability.
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

  @Get(':aiEmployeeId/keys')
  @RequireCapability('people.view')
  listKeys(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
  ): Promise<AgentKeyListView> {
    return this.service.listKeys(context, principal, aiEmployeeId);
  }

  @Post(':aiEmployeeId/keys')
  @RequireCapability('people.view')
  createKey(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Body() body: unknown,
  ): Promise<CreatedAgentKeyView> {
    return this.service.createKey(context, principal, aiEmployeeId, body);
  }

  @Post(':aiEmployeeId/keys/:keyId/rotate')
  @HttpCode(200)
  @RequireCapability('people.view')
  rotateKey(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Param('keyId') keyId: string,
    @Body() body: unknown,
  ): Promise<CreatedAgentKeyView> {
    return this.service.rotateKey(context, principal, aiEmployeeId, keyId, body);
  }

  @Delete(':aiEmployeeId/keys/:keyId')
  @HttpCode(204)
  @RequireCapability('people.view')
  revokeKey(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Param('keyId') keyId: string,
  ): Promise<void> {
    return this.service.revokeKey(context, principal, aiEmployeeId, keyId);
  }
}
