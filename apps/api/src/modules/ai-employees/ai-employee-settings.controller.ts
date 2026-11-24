import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  AiEmployeeSettingsService,
  AiEmployeeSettingsView,
} from './ai-employee-settings.service.js';

export const AI_EMPLOYEE_SETTINGS_SERVICE = Symbol.for('tmanage.AiEmployeeSettingsService');

/**
 * 60-07 (plan 60 v2 §4.10 S8) — `/v1/organizations/:orgSlug/ai-employees/settings`: the
 * workspace's rules for AI employees. Both routes need `ai_employee.manage` and a person's own
 * session (an API key or an agent is refused), and are NEVER in the AI registry
 * (`ai_employee_admin`). A static segment, so it never matches `:aiEmployeeId`.
 */
@Controller('v1/organizations/:orgSlug/ai-employees/settings')
export class AiEmployeeSettingsController {
  constructor(
    @Inject(AI_EMPLOYEE_SETTINGS_SERVICE) private readonly service: AiEmployeeSettingsService,
  ) {}

  @Get()
  @RequireCapability('ai_employee.manage')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiEmployeeSettingsView> {
    return this.service.get(context, principal);
  }

  @Put()
  @RequireCapability('ai_employee.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<AiEmployeeSettingsView> {
    return this.service.update(context, principal, body);
  }
}
