import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { DueDateSuggestion, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { SuggestDueService } from './suggest-due.service.js';

/**
 * 55-07 (R18-d) — `GET …/projects/:projectId/suggest-due`: a due date to prefill when a member
 * creates an item, `{ date, reason }`. `work.read` on the route; the service adds the project
 * relation (a project the caller cannot read is a 404). Read-only, no audit.
 */
@Controller('v1/organizations/:orgSlug/projects/:projectId/suggest-due')
export class SuggestDueController {
  constructor(@Inject(SuggestDueService) private readonly service: SuggestDueService) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<DueDateSuggestion> {
    return this.service.suggest(context, principal, projectId);
  }
}
