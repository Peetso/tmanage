import { Controller, Delete, Get, HttpCode, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  AiEmployeeConnectionListView,
  AiEmployeeConnectionsService,
} from './connections.service.js';

export const AI_EMPLOYEE_CONNECTIONS_SERVICE = Symbol.for('tmanage.AiEmployeeConnectionsService');

/**
 * 60-07 (plan 60 v2 §4.5; S6b) — an AI employee's connections,
 * `/v1/organizations/:orgSlug/ai-employees/:aiEmployeeId/connections`. A person's cookie session
 * only, NEVER in the AI registry (`ai_employee_admin`), 404 while the server switch is off:
 *
 * - `GET ''` — live agent keys and connectors with who added each, last use, end, and the cap.
 * - `DELETE connectors/:grantId` — stop a connector now (grant and tokens), in every status.
 *
 * The guard asks `people.view`; the service decides "who may bind" (the sponsor, or a holder of
 * `ai_employee.manage`), because a sponsor need not hold the manage capability.
 */
@Controller('v1/organizations/:orgSlug/ai-employees/:aiEmployeeId/connections')
export class AiEmployeeConnectionsController {
  constructor(
    @Inject(AI_EMPLOYEE_CONNECTIONS_SERVICE)
    private readonly service: AiEmployeeConnectionsService,
  ) {}

  @Get()
  @RequireCapability('people.view')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
  ): Promise<AiEmployeeConnectionListView> {
    return this.service.list(context, principal, aiEmployeeId);
  }

  @Delete('connectors/:grantId')
  @HttpCode(204)
  @RequireCapability('people.view')
  revokeConnector(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('aiEmployeeId') aiEmployeeId: string,
    @Param('grantId') grantId: string,
  ): Promise<void> {
    return this.service.revokeConnector(context, principal, aiEmployeeId, grantId);
  }
}
