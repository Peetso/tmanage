import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../../common/http/decorators.js';
import type {
  BusinessFactListView,
  BusinessFactView,
  BusinessMemoryService,
} from './business-memory.service.js';

export const BUSINESS_MEMORY_SERVICE = Symbol.for('tmanage.BusinessMemoryService');

/**
 * 62-26 — Business Memory, `/v1/organizations/:orgSlug/business-memory`:
 *
 * - `GET facts?status=&entityType=&entityId=&stale=` (`ai.use`): the facts the member may read;
 *   proposals of others only for approvers (`ai.manage`).
 * - `GET recall?entities=client:<id>,project:<id>,company` (`ai.use`): at most eight approved
 *   facts about those entities, for the AI chat tool `recall_business_memory`.
 * - `POST facts` (`ai.use`): propose a fact (status `proposed`).
 * - `PATCH facts/:factId`, `POST facts/:factId/approve|confirm|retire` (`ai.manage`): a person's
 *   decisions; never AI ops.
 */
@Controller('v1/organizations/:orgSlug/business-memory')
export class BusinessMemoryController {
  constructor(@Inject(BUSINESS_MEMORY_SERVICE) private readonly service: BusinessMemoryService) {}

  @Get('facts')
  @RequireCapability('ai.use')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('status') status?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('stale') stale?: string,
  ): Promise<BusinessFactListView> {
    return this.service.list(context, principal, {
      ...(status === undefined ? {} : { status }),
      ...(entityType === undefined ? {} : { entityType }),
      ...(entityId === undefined ? {} : { entityId }),
      ...(stale === undefined ? {} : { stale }),
    });
  }

  @Get('recall')
  @RequireCapability('ai.use')
  recall(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('entities') entities?: string,
  ): Promise<BusinessFactListView> {
    return this.service.recall(context, principal, entities);
  }

  @Post('facts')
  @RequireCapability('ai.use')
  propose(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<BusinessFactView> {
    return this.service.propose(context, principal, body);
  }

  @Patch('facts/:factId')
  @RequireCapability('ai.manage')
  edit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('factId') factId: string,
    @Body() body: unknown,
  ): Promise<BusinessFactView> {
    return this.service.edit(context, principal, factId, body);
  }

  @Post('facts/:factId/approve')
  @HttpCode(200)
  @RequireCapability('ai.manage')
  approve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('factId') factId: string,
  ): Promise<BusinessFactView> {
    return this.service.approve(context, principal, factId);
  }

  @Post('facts/:factId/confirm')
  @HttpCode(200)
  @RequireCapability('ai.manage')
  confirm(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('factId') factId: string,
  ): Promise<BusinessFactView> {
    return this.service.confirm(context, principal, factId);
  }

  @Post('facts/:factId/retire')
  @HttpCode(200)
  @RequireCapability('ai.manage')
  retire(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('factId') factId: string,
  ): Promise<BusinessFactView> {
    return this.service.retire(context, principal, factId);
  }
}
