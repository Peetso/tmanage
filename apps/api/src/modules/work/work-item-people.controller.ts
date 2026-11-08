import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { MAX_PEOPLE_PER_ROLE } from './work-item-people.service.js';
import type { WorkItemPeopleService, WorkItemPeopleView } from './work-item-people.service.js';

export const WORK_ITEM_PEOPLE_SERVICE = Symbol.for('tmanage.WorkItemPeopleService');

/**
 * C26 — the people on a task: who does it (lead first), who supervises it, and adding several
 * watchers at once. Reading is `work.read`; changing anyone's role is `work.update`, the owner's
 * gate. The service resolves the item tenant-scoped before it authorizes or writes.
 */
@Controller('v1/organizations/:orgSlug/work-items/:workItemId/people')
export class WorkItemPeopleController {
  constructor(@Inject(WORK_ITEM_PEOPLE_SERVICE) private readonly people: WorkItemPeopleService) {}

  @Get()
  @RequireCapability('work.read')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkItemPeopleView> {
    return this.people.read(context, principal, workItemId);
  }

  @Put('doers')
  @RequireCapability('work.update')
  async setDoers(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly userIds?: unknown } | undefined,
  ): Promise<WorkItemPeopleView> {
    return this.people.setRole(context, principal, workItemId, 'doer', userIdList(body));
  }

  @Put('supervisors')
  @RequireCapability('work.update')
  async setSupervisors(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly userIds?: unknown } | undefined,
  ): Promise<WorkItemPeopleView> {
    return this.people.setRole(context, principal, workItemId, 'supervisor', userIdList(body));
  }

  @Post('watchers')
  @RequireCapability('work.update')
  async addWatchers(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly userIds?: unknown } | undefined,
  ): Promise<{ readonly added: number }> {
    return this.people.addWatchers(context, principal, workItemId, userIdList(body));
  }
}

/** `userIds`: a list of at most 50 non-empty ids of at most 64 characters. */
export function userIdList(body: { readonly userIds?: unknown } | undefined): readonly string[] {
  const raw = body?.userIds;
  if (
    !Array.isArray(raw) ||
    raw.length > MAX_PEOPLE_PER_ROLE ||
    raw.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 64)
  ) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'userIds', message: `must be a list of at most ${MAX_PEOPLE_PER_ROLE} user ids` },
    ]);
  }
  return raw as string[];
}
