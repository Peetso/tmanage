import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  UsageAlertsService,
  type UsageAlertStatusView,
  type UsageAlertView,
} from './usage-alerts.service.js';
import { USAGE_ALERT_METRICS } from './usage-alerts.types.js';
import type { UsageAlertMetric } from './usage-alerts.types.js';

/**
 * Billing & entitlements (module 19, x200). Configurable usage-alert threshold rules over the existing
 * usage/quota reads. Four routes: create a rule, list a tenant's rules, update a rule's
 * threshold/active, and read which active rules are currently breached.
 *
 * The controller is the HTTP boundary: it validates the request (metric allowlist, threshold bound), and
 * delegates the tenant-scoping, authorization and status computation to {@link UsageAlertsService}. Every
 * route reuses `org.manage` — no billing capability exists and this slice adds none (the storage-usage
 * read `usage.controller.ts` records the same divergence). An off-list `metric` or an out-of-range
 * `thresholdPercent` (outside 1–100) is a 400 with no write, decided before the service is touched.
 */

const THRESHOLD_MIN = 1;
const THRESHOLD_MAX = 100;

interface CreateUsageAlertBody {
  readonly metric?: unknown;
  readonly thresholdPercent?: unknown;
  readonly active?: unknown;
}

interface UpdateUsageAlertBody {
  readonly thresholdPercent?: unknown;
  readonly active?: unknown;
}

/** DI token for the service, private to this slice so no `tokens.ts` edit is needed (the schedules
 * posture). Declared before the controller so its `@Inject` decorator can reference it. */
const USAGE_ALERTS_SERVICE = Symbol.for('tmanage.UsageAlertsService');

@Controller('v1/organizations/:orgSlug/billing/usage-alerts')
export class UsageAlertsController {
  constructor(@Inject(USAGE_ALERTS_SERVICE) private readonly alerts: UsageAlertsService) {}

  /** List the acting tenant's usage-alert rules, metric-ascending. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly alerts: readonly UsageAlertView[] }> {
    return { alerts: await this.alerts.list(context, principal) };
  }

  /** Read which rules are currently breached. `org.manage`. Computes only; dispatches nothing. */
  @Get('status')
  @RequireCapability('org.manage')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly statuses: readonly UsageAlertStatusView[] }> {
    return { statuses: await this.alerts.status(context, principal) };
  }

  /** Create a usage-alert rule. `org.manage`. An off-list metric or out-of-range threshold is a 400. */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateUsageAlertBody,
  ): Promise<UsageAlertView> {
    const metric = validateMetric(body?.metric);
    const thresholdPercent = validateThreshold(body?.thresholdPercent);
    const active = validateActive(body?.active) ?? true;
    return this.alerts.create(context, principal, { metric, thresholdPercent, active });
  }

  /**
   * Update a rule's threshold and/or active flag. A cross-tenant or missing id is a 404; an out-of-range
   * threshold is a 400 with no write. `org.manage`.
   */
  @Patch(':id')
  @RequireCapability('org.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: UpdateUsageAlertBody,
  ): Promise<UsageAlertView> {
    requireId(id);
    const thresholdPercent =
      body?.thresholdPercent === undefined ? undefined : validateThreshold(body.thresholdPercent);
    const active = validateActive(body?.active);
    if (thresholdPercent === undefined && active === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: 'must set thresholdPercent and/or active' },
      ]);
    }
    return this.alerts.update(context, principal, id, {
      ...(thresholdPercent === undefined ? {} : { thresholdPercent }),
      ...(active === undefined ? {} : { active }),
    });
  }
}

function validateMetric(raw: unknown): UsageAlertMetric {
  if (typeof raw !== 'string' || !(USAGE_ALERT_METRICS as readonly string[]).includes(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'metric', message: `must be one of ${USAGE_ALERT_METRICS.join(', ')}` }],
      'usage_alert_metric_off_list',
    );
  }
  return raw as UsageAlertMetric;
}

function validateThreshold(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < THRESHOLD_MIN ||
    raw > THRESHOLD_MAX
  ) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [
        {
          field: 'thresholdPercent',
          message: `must be an integer between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}`,
        },
      ],
      'usage_alert_threshold_out_of_range',
    );
  }
  return raw;
}

function validateActive(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'active', message: 'must be a boolean' },
    ]);
  }
  return raw;
}

function requireId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new ApiError(400, 'validation_failed', 'id is required', [
      { field: 'id', message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * Billing & entitlements (module 19, x200). The module that wires the controller and its service.
 * Registered in `app.module.ts` directly rather than folded into a shared billing module, so this slice
 * touches no file another billing slice in the same pass appends to. It reuses `org.manage`, so it adds
 * nothing to the capability files.
 */
@Module({})
export class BillingUsageAlertsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: USAGE_ALERTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new UsageAlertsService(database),
    };

    return {
      module: BillingUsageAlertsModule,
      providers: [service],
      controllers: [UsageAlertsController],
    };
  }
}
