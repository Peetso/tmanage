import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { ExpensePage, ExpenseView, ExpensesService } from './expenses.service.js';

interface HeaderWriter {
  header(name: string, value: string): unknown;
}

export const EXPENSES_SERVICE = Symbol.for('tmanage.ExpensesService');

/**
 * 52-07 — `/v1/organizations/:orgSlug/expenses`. Capability stand-ins (no `capabilities.ts` edit):
 * `expense.submit` → `work.read` + internal principal (as TIME_TRACK_OWN); `expense.approve` →
 * `project.manage` on the expense's project (`finance.manage` when it has none), never one's own;
 * `expense.view_all` and the export → `finance.manage`. The service re-checks each against the
 * row. Org-internal: no portal route, so cost and markup never reach a client principal.
 */
@Controller('v1/organizations/:orgSlug/expenses')
export class ExpensesController {
  constructor(@Inject(EXPENSES_SERVICE) private readonly service: ExpensesService) {}

  @Post()
  @HttpCode(201)
  @RequireCapability('work.read')
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<ExpenseView> {
    return this.service.create(context, principal, body);
  }

  @Get()
  @RequireCapability('work.read')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query() query: Record<string, unknown>,
  ): Promise<ExpensePage> {
    return this.service.list(context, principal, query);
  }

  /** Static segment: matched before `:expenseId`. */
  @Get('export.csv')
  @RequireCapability('finance.manage')
  async exportCsv(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const csv = await this.service.exportCsv(context, principal, query);
    reply.header('content-disposition', 'attachment; filename="expenses.csv"');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(Buffer.from(csv, 'utf-8'), { type: 'text/csv; charset=utf-8' });
  }

  @Get(':expenseId')
  @RequireCapability('work.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('expenseId') expenseId: string,
  ): Promise<ExpenseView> {
    return this.service.get(context, principal, expenseId);
  }

  @Put(':expenseId')
  @RequireCapability('work.read')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('expenseId') expenseId: string,
    @Body() body: unknown,
  ): Promise<ExpenseView> {
    return this.service.update(context, principal, expenseId, body);
  }

  @Delete(':expenseId')
  @HttpCode(204)
  @RequireCapability('work.read')
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('expenseId') expenseId: string,
  ): Promise<void> {
    await this.service.remove(context, principal, expenseId);
  }

  @Post(':expenseId/submit')
  @HttpCode(200)
  @RequireCapability('work.read')
  submit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('expenseId') expenseId: string,
  ): Promise<ExpenseView> {
    return this.service.submit(context, principal, expenseId);
  }

  @Post(':expenseId/approve')
  @HttpCode(200)
  @RequireCapability('project.manage')
  approve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('expenseId') expenseId: string,
    @Body() body: unknown,
  ): Promise<ExpenseView> {
    return this.service.approve(context, principal, expenseId, body);
  }

  @Post(':expenseId/reject')
  @HttpCode(200)
  @RequireCapability('project.manage')
  reject(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('expenseId') expenseId: string,
    @Body() body: unknown,
  ): Promise<ExpenseView> {
    return this.service.reject(context, principal, expenseId, body);
  }
}
