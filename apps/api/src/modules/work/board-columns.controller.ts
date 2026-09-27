import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { WORK_BOARD_COLUMNS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { BoardColumnView, WorkBoardColumnsService } from './board-columns.service.js';

/**
 * x308's HTTP surface — an organization's custom work-board columns (Work module 7).
 *
 * The board read is any member's (`work.read`); defining, editing and removing a column is org
 * configuration (`org.manage`). The `@RequireCapability` decorator is the coarse HTTP gate; the
 * service makes the real org-wide, tenant-checked decision and resolves the column tenant-scoped
 * before it authorizes a write — a cross-tenant id is a 404, before any write.
 */

interface ColumnBody {
  readonly label?: unknown;
  readonly stateKey?: unknown;
  readonly position?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class WorkBoardColumnsController {
  constructor(
    @Inject(WORK_BOARD_COLUMNS_SERVICE) private readonly columns: WorkBoardColumnsService,
  ) {}

  @Get('work/board-columns')
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly columns: readonly BoardColumnView[] }> {
    return { columns: await this.columns.list(context) };
  }

  @Post('work/board-columns')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async define(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: ColumnBody,
  ): Promise<BoardColumnView> {
    return this.columns.define(context, principal, {
      label: body?.label as string,
      stateKey: body?.stateKey as string,
      position: body?.position as number,
    });
  }

  @Put('work/board-columns/:columnId')
  @RequireCapability('org.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('columnId') columnId: string,
    @Body() body: ColumnBody,
  ): Promise<BoardColumnView> {
    return this.columns.update(context, principal, columnId, {
      label: body?.label as string,
      stateKey: body?.stateKey as string,
      position: body?.position as number,
    });
  }

  @Delete('work/board-columns/:columnId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('columnId') columnId: string,
  ): Promise<void> {
    await this.columns.remove(context, principal, columnId);
  }
}
