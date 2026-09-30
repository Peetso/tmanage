import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { CostCentersService, type CostCenterView } from './cost-centers.service.js';

/**
 * Billing & entitlements (module 19, x281). Named cost centers a billing admin defines, and the
 * projects assigned to them, so usage/spend can later be grouped by cost center. Definitions and
 * assignments only — nothing here stores an amount or charges.
 *
 * Five routes, all behind `org.manage`: create a definition, list the tenant's definitions with their
 * assigned project ids, delete a definition, assign a project, and unassign a project. The controller is
 * the HTTP boundary: it validates the request (non-empty `code`/`name`, bounded length) and delegates
 * the tenant-scoping, cross-tenant resolution and authorization to {@link CostCentersService}. Every
 * route reuses `org.manage` — no billing capability exists and this slice adds none (the same
 * divergence `usage-alerts.controller.ts` records). An empty `code`/`name` is a 400 with no write,
 * decided before the service is touched; a cross-tenant cost center or project id is a 404 the service
 * raises before it authorizes.
 */

const CODE_MAX = 64;
const NAME_MAX = 190;

interface CreateCostCenterBody {
  readonly code?: unknown;
  readonly name?: unknown;
}

/** DI token for the service, private to this slice so no `tokens.ts` edit is needed. */
const COST_CENTERS_SERVICE = Symbol.for('tmanage.CostCentersService');

@Controller('v1/organizations/:orgSlug/billing/cost-centers')
export class CostCentersController {
  constructor(@Inject(COST_CENTERS_SERVICE) private readonly costCenters: CostCentersService) {}

  /** List the acting tenant's cost centers with their assigned project ids. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly costCenters: readonly CostCenterView[] }> {
    return { costCenters: await this.costCenters.list(context, principal) };
  }

  /** Create a cost-center definition. `org.manage`. An empty code/name is a 400; a duplicate code 409. */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateCostCenterBody,
  ): Promise<CostCenterView> {
    const code = validateText(body?.code, 'code', CODE_MAX);
    const name = validateText(body?.name, 'name', NAME_MAX);
    return this.costCenters.create(context, principal, { code, name });
  }

  /** Delete a cost center and its assignments. A cross-tenant or missing id is a 404. `org.manage`. */
  @Delete(':id')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    requireId(id, 'id');
    await this.costCenters.remove(context, principal, id);
  }

  /**
   * Assign a project to a cost center. Idempotent — a repeat assignment is a 204, not a second row. A
   * cross-tenant or missing cost center or project id is a 404 with no write. `org.manage`.
   */
  @Put(':id/projects/:projectId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    requireId(id, 'id');
    requireId(projectId, 'projectId');
    await this.costCenters.assignProject(context, principal, id, projectId);
  }

  /**
   * Remove a project assignment from a cost center. Idempotent — an absent assignment is still a 204. A
   * cross-tenant or missing cost center id is a 404. `org.manage`.
   */
  @Delete(':id/projects/:projectId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async unassign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    requireId(id, 'id');
    requireId(projectId, 'projectId');
    await this.costCenters.unassignProject(context, principal, id, projectId);
  }
}

/** A required, trimmed, bounded free-text field. Empty or over-length is a 400 with no write. */
function validateText(raw: unknown, field: string, max: number): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '' || value.length > max) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field, message: `must be a non-empty string of at most ${max} characters` }],
      `cost_center_${field}_invalid`,
    );
  }
  return value;
}

function requireId(id: unknown, field: string): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * Billing & entitlements (module 19, x281). The module that wires the controller and its service.
 * Registered in `app.module.ts` directly rather than folded into the shared billing module, so this
 * slice touches no file another billing slice in the same pass appends to. It reuses `org.manage`, so
 * it adds nothing to the capability files.
 */
@Module({})
export class BillingCostCentersModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: COST_CENTERS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new CostCentersService(database),
    };

    return {
      module: BillingCostCentersModule,
      providers: [service],
      controllers: [CostCentersController],
    };
  }
}
