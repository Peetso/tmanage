import { Controller, Get, Inject } from '@nestjs/common';
import type { TenantContext } from '../../../common/database/tenant-context.js';
import { Ctx, RequireCapability } from '../../../common/http/decorators.js';
import type { WorkspaceIncidentsService } from './workspace-incidents.service.js';

export const WORKSPACE_INCIDENTS_SERVICE = Symbol.for('tmanage.WorkspaceIncidentsService');

/**
 * A17 — `GET /v1/organizations/:orgSlug/admin/incidents`: the incidents a workspace owner may see
 * (published, or announced to this workspace). Behind `org.manage`; the service re-checks it.
 */
@Controller('v1/organizations/:orgSlug/admin/incidents')
export class WorkspaceIncidentsController {
  constructor(
    @Inject(WORKSPACE_INCIDENTS_SERVICE) private readonly service: WorkspaceIncidentsService,
  ) {}

  @Get()
  @RequireCapability('org.manage')
  list(@Ctx() context: TenantContext) {
    return this.service.list(context);
  }
}
