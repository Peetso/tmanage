import { Body, Controller, Get, Inject, Param, Put, Query } from '@nestjs/common';
import { isBudgetType, validAlertThresholds } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_BUDGET_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  BUDGET_BURN_SERVICE,
  type BudgetBurnService,
  type BurnReportView,
} from './budget-burn.service.js';
import {
  MAX_BUDGET_AMOUNT_MINOR,
  MAX_BUDGET_HOURS,
  MAX_BUDGET_PHASES,
  type BudgetPhaseCommand,
  type ProjectBudgetService,
  type ProjectBudgetView,
  type SaveProjectBudgetCommand,
} from './budget.service.js';

/**
 * PROJ / project detail (x293). A project's **budget** — set it (effort and/or amount) and read a
 * budget-vs-tracked summary that sums the effort already logged on the project's work items.
 *
 * Nested under `…/projects/:projectId/budget`, so the project is named in the path and the service
 * resolves it tenant-scoped before it authorizes, reads, or writes (Known-trap). Both routes are
 * gated on `project.manage`: setting and reading a budget is a manage-level view of a project's plan.
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a header,
 * or its own `:orgSlug` segment.
 *
 * The amount is numbers only — a planning figure, never a payment. There is no charge, ledger, or
 * rate here.
 */

interface SaveBudgetBody {
  readonly budgetHours?: unknown;
  readonly budgetAmountMinor?: unknown;
  readonly currency?: unknown;
  // ---- 52-05 ----
  readonly budgetType?: unknown;
  readonly includeExpenses?: unknown;
  readonly clientVisible?: unknown;
  readonly alertThresholds?: unknown;
  readonly phases?: unknown;
}

type Detail = { field: string; message: string };

function hoursValid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_BUDGET_HOURS &&
    Number.isInteger(value * 60)
  );
}

function amountValid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_BUDGET_AMOUNT_MINOR
  );
}

/** 52-05. The replace-all phase split: <= 20 lines, each named, figures like the budget's own. */
function parsePhases(raw: unknown, details: Detail[]): BudgetPhaseCommand[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > MAX_BUDGET_PHASES) {
    details.push({ field: 'phases', message: `must be an array of at most ${MAX_BUDGET_PHASES}` });
    return undefined;
  }
  return raw.map((entry: unknown, index): BudgetPhaseCommand => {
    const line = (entry ?? {}) as Record<string, unknown>;
    const field = `phases[${index}]`;
    const name = typeof line['name'] === 'string' ? line['name'].trim() : '';
    if (name === '' || name.length > 120) details.push({ field, message: 'name is 1-120 chars' });
    const phaseId = line['phaseId'] ?? null;
    if (phaseId !== null && (typeof phaseId !== 'string' || phaseId.length !== 36)) {
      details.push({ field, message: 'phaseId must be a phase id or null' });
    }
    const hours = line['budgetHours'] ?? null;
    if (hours !== null && !hoursValid(hours)) details.push({ field, message: 'bad budgetHours' });
    const amount = line['budgetAmountMinor'] ?? null;
    if (amount !== null && !amountValid(amount)) {
      details.push({ field, message: 'bad budgetAmountMinor' });
    }
    const position = line['position'] ?? index;
    if (!Number.isSafeInteger(position)) details.push({ field, message: 'bad position' });
    return {
      phaseId: phaseId as string | null,
      name,
      budgetHours: hours as number | null,
      budgetAmountMinor: amount as number | null,
      position: position as number,
    };
  });
}

/** ISO-4217 alphabetic codes are three uppercase letters. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

@Controller('v1/organizations/:orgSlug/projects/:projectId/budget')
export class ProjectBudgetController {
  constructor(
    @Inject(PROJECT_BUDGET_SERVICE) private readonly budgets: ProjectBudgetService,
    @Inject(BUDGET_BURN_SERVICE) private readonly burns: BudgetBurnService,
  ) {}

  /**
   * 52-05. The burn grouped by week (default) or person (`project.manage` only, paginated with
   * `after`/`limit`), over `from..to` (default the last 12 weeks, at most two years). `work.read`
   * with a project relation (the 52-05 `budget.view` stand-in); money keys need `finance.view`.
   */
  @Get('burn')
  @RequireCapability('work.read')
  async burn(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('groupBy') groupBy?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<BurnReportView> {
    return this.burns.burn(context, principal, projectId, {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(groupBy !== undefined ? { groupBy } : {}),
      ...(after !== undefined ? { after } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  @Get()
  @RequireCapability('project.manage')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectBudgetView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }
    return this.budgets.get(context, principal, projectId);
  }

  /**
   * Set (create or replace) a project's budget. At least one of `budgetHours` / `budgetAmountMinor`
   * must be present, each `>= 0`; `budgetHours` must be a whole number of minutes; `currency` is
   * required with an amount, forbidden without one, and must be an ISO-4217 alphabetic code. Any
   * violation is a 400 and nothing is written (the service is never called).
   */
  @Put()
  @RequireCapability('project.manage')
  async save(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: SaveBudgetBody,
  ): Promise<ProjectBudgetView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const hoursProvided = body?.budgetHours !== undefined && body?.budgetHours !== null;
    const amountProvided =
      body?.budgetAmountMinor !== undefined && body?.budgetAmountMinor !== null;
    const currencyProvided = body?.currency !== undefined && body?.currency !== null;

    const details: { field: string; message: string }[] = [];

    if (!hoursProvided && !amountProvided) {
      details.push({
        field: 'body',
        message: 'at least one of budgetHours or budgetAmountMinor must be provided',
      });
    }

    if (hoursProvided) {
      const hours = body.budgetHours;
      if (
        typeof hours !== 'number' ||
        !Number.isFinite(hours) ||
        hours < 0 ||
        hours > MAX_BUDGET_HOURS ||
        !Number.isInteger(hours * 60)
      ) {
        details.push({
          field: 'budgetHours',
          message: `must be a number between 0 and ${MAX_BUDGET_HOURS} in whole-minute increments`,
        });
      }
    }

    if (amountProvided) {
      const amount = body.budgetAmountMinor;
      if (
        typeof amount !== 'number' ||
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        amount > MAX_BUDGET_AMOUNT_MINOR
      ) {
        details.push({
          field: 'budgetAmountMinor',
          message: `must be an integer between 0 and ${MAX_BUDGET_AMOUNT_MINOR}`,
        });
      }
    }

    if (amountProvided && !currencyProvided) {
      details.push({
        field: 'currency',
        message: 'is required when budgetAmountMinor is provided',
      });
    }
    if (!amountProvided && currencyProvided) {
      details.push({
        field: 'currency',
        message: 'may only be provided together with budgetAmountMinor',
      });
    }
    if (currencyProvided) {
      const currency = body.currency;
      if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
        details.push({
          field: 'currency',
          message: 'must be an ISO-4217 alphabetic code (three uppercase letters)',
        });
      }
    }

    if (body?.budgetType !== undefined && !isBudgetType(body.budgetType)) {
      details.push({ field: 'budgetType', message: 'must be hours, money or both' });
    }
    for (const flag of ['includeExpenses', 'clientVisible'] as const) {
      if (body?.[flag] !== undefined && typeof body[flag] !== 'boolean') {
        details.push({ field: flag, message: 'must be a boolean' });
      }
    }
    const thresholds = body?.alertThresholds;
    if (
      thresholds !== undefined &&
      (!Array.isArray(thresholds) || !validAlertThresholds(thresholds))
    ) {
      details.push({
        field: 'alertThresholds',
        message: 'must be 1 to 4 whole percents between 1 and 100, ascending',
      });
    }
    const phases = parsePhases(body?.phases, details);

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const command: SaveProjectBudgetCommand = {
      budgetHours: hoursProvided ? (body.budgetHours as number) : null,
      budgetAmountMinor: amountProvided ? (body.budgetAmountMinor as number) : null,
      currency: amountProvided && currencyProvided ? (body.currency as string) : null,
      ...(isBudgetType(body.budgetType) ? { budgetType: body.budgetType } : {}),
      ...(typeof body.includeExpenses === 'boolean'
        ? { includeExpenses: body.includeExpenses }
        : {}),
      ...(typeof body.clientVisible === 'boolean' ? { clientVisible: body.clientVisible } : {}),
      ...(Array.isArray(thresholds) ? { alertThresholds: thresholds as number[] } : {}),
      ...(phases !== undefined ? { phases } : {}),
    };

    return this.budgets.save(context, principal, projectId, command);
  }
}
