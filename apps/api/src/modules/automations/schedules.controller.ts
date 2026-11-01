import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AutomationScheduleRow } from '../../common/database/schema.js';
import { AutomationSchedulesRepository } from './schedules.repository.js';
import { computeNextRunAt, parseScheduleSpec } from './next-run.js';
import type { ScheduleSpec } from './next-run.js';

/**
 * Automations scheduled triggers (x167). The service and controller for a workflow template's
 * schedules — record a cron-like recurrence for a template, and list a tenant's schedules.
 *
 * The service is co-located here (with the module that wires it) rather than in a separate file
 * because it is small and the slice adds no other consumer of it, the shape
 * `DocumentTemplateVariablesController` uses. It follows the two-layer authorization every
 * tenant-scoped write here uses: the route guard asks the coarse `org.manage` question, and this
 * service adds the authoritative application decision — resolving the named template tenant-scoped
 * **before** it authorizes or writes (the Known-trap order), then authorizing `org.manage`
 * org-scoped, then validating the spec. Scheduling is an organization-administration act, so the
 * capability is `org.manage` (an org-level resource, `projectId: null`), the same gate the client
 * organizations and org settings surfaces use.
 *
 * ## What it does, and what it cannot
 *
 * The schedule is recorded and its `nextRunAt` is computed deterministically ({@link computeNextRunAt},
 * a pure function given `now`). Nothing here fires a run: a background dispatcher that wakes on
 * `nextRunAt` and enqueues the workflow is worker infrastructure (Needs-Peter), out of this slice.
 */

/** What a caller is allowed to see of a schedule. `organizationId` is deliberately absent. */
export interface AutomationScheduleView {
  readonly id: string;
  readonly templateId: string;
  readonly spec: ScheduleSpec;
  /** The next fire instant, an ISO-8601 string on the wire. */
  readonly nextRunAt: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7): a column added to
 * `automation_schedules` later is invisible to every caller until named here. `organization_id` is
 * never echoed into a response body.
 */
function toView(row: AutomationScheduleRow): AutomationScheduleView {
  return {
    id: row.id,
    templateId: row.templateId,
    spec: row.specJson as ScheduleSpec,
    nextRunAt: row.nextRunAt.toISOString(),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export class AutomationSchedulesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly schedules: AutomationSchedulesRepository = new AutomationSchedulesRepository(),
  ) {}

  /**
   * Resolve the named template tenant-scoped, **before** any authorize or write (the Known-trap
   * order, FAST-PROTOCOL 19:55): a missing `templateId`, or one that belongs to another tenant,
   * resolves to no row and becomes a **404** here, never a foreign-key 500 an org-wide caller would
   * reach after passing the authorize below.
   */
  private async requireTemplate(context: TenantContext, templateId: string): Promise<void> {
    const exists = await this.database.read(context, (runner) =>
      this.schedules.templateExists(runner, context, templateId),
    );
    if (!exists) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'template_not_visible');
    }
  }

  /** Authorize an org-scoped `org.manage` (`projectId: null`), or throw 403. */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Null, deliberately: a schedule is an org-level resource, so a project relation must not
        // stand in for the organization-wide capability.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }

  /**
   * Record a schedule for a template. Resolves the template tenant-scoped (404) before it authorizes
   * (`org.manage`, 403), validates the spec (400 with no write on an off-enum interval or an
   * out-of-range hour/day), computes `nextRunAt` deterministically from `now`, and writes.
   *
   * `now` is a parameter so the computation is deterministic and testable; the controller passes the
   * current instant.
   */
  async schedule(
    context: TenantContext,
    principal: Principal,
    templateId: string,
    rawSpec: unknown,
    options: { readonly enabled?: boolean; readonly now?: Date } = {},
  ): Promise<AutomationScheduleView> {
    await this.requireTemplate(context, templateId);
    this.requireOrgManage(principal, context, 'automation_schedule.create');

    const parsed = parseScheduleSpec(rawSpec);
    if (!parsed.ok) {
      throw new ApiError(400, 'validation_failed', 'The schedule spec is invalid', [
        ...parsed.errors,
      ]);
    }

    const nextRunAt = computeNextRunAt(parsed.spec, options.now ?? new Date());

    const row = await this.database.transaction(context, (tx) =>
      this.schedules.create(tx, context, {
        templateId,
        spec: parsed.spec,
        nextRunAt,
        // Chosen at creation (defaults to enabled); PATCH schedules/:id turns it on or off later.
        enabled: options.enabled ?? true,
      }),
    );
    return toView(row);
  }

  /**
   * 2026-10-31 live-test fix: turn one schedule on or off. Authorizes `org.manage` (403), then
   * resolves the schedule tenant-scoped (404 for an unknown or another tenant's id). Turning it on
   * recomputes `nextRunAt` from `now`, so it never resumes with a due time in the past.
   */
  async setEnabled(
    context: TenantContext,
    principal: Principal,
    scheduleId: string,
    enabled: boolean,
    now: Date = new Date(),
  ): Promise<AutomationScheduleView> {
    this.requireOrgManage(principal, context, 'automation_schedule.update');
    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.schedules.findById(tx, context, scheduleId);
      if (!existing) return null;
      const stored: unknown =
        typeof existing.specJson === 'string' ? JSON.parse(existing.specJson) : existing.specJson;
      const spec = parseScheduleSpec(stored);
      const nextRunAt = enabled && spec.ok ? computeNextRunAt(spec.spec, now) : null;
      await this.schedules.setEnabled(tx, context, scheduleId, enabled, nextRunAt);
      return this.schedules.findById(tx, context, scheduleId);
    });
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'schedule_not_visible');
    }
    return toView(row);
  }

  /**
   * 2026-10-31 live-test fix: remove one schedule. `org.manage` (403), then tenant-scoped resolve
   * (404). Runs it already made stay in the run history.
   */
  async remove(context: TenantContext, principal: Principal, scheduleId: string): Promise<void> {
    this.requireOrgManage(principal, context, 'automation_schedule.delete');
    const removed = await this.database.transaction(context, (tx) =>
      this.schedules.remove(tx, context, scheduleId),
    );
    if (!removed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'schedule_not_visible');
    }
  }

  /** List the acting tenant's schedules, soonest-due first, for a caller who may manage the org. */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly AutomationScheduleView[]> {
    this.requireOrgManage(principal, context, 'automation_schedule.list');
    const rows = await this.database.read(context, (runner) =>
      this.schedules.list(runner, context),
    );
    return rows.map(toView);
  }
}

/** DI token for the co-located service, so no `tokens.ts` edit is needed for this slice. */
const AUTOMATION_SCHEDULES_SERVICE = Symbol.for('tmanage.AutomationSchedulesService');

/** POST body for scheduling a template. Untrusted; the spec is validated in `next-run.ts`. */
interface ScheduleBody {
  readonly interval?: unknown;
  readonly hour?: unknown;
  readonly dayOfWeek?: unknown;
  readonly enabled?: unknown;
}

/** A path `templateId` is always required and always a non-empty string. */
function requireTemplateId(templateId: unknown): asserts templateId is string {
  if (typeof templateId !== 'string' || templateId === '') {
    throw new ApiError(400, 'validation_failed', 'templateId is required', [
      { field: 'templateId', message: 'must be a non-empty string' },
    ]);
  }
}

/** PATCH body for one schedule. Untrusted. */
interface ScheduleUpdateBody {
  readonly enabled?: unknown;
}

@Controller('v1/organizations/:orgSlug/automations')
export class AutomationSchedulesController {
  constructor(
    @Inject(AUTOMATION_SCHEDULES_SERVICE)
    private readonly schedules: AutomationSchedulesService,
  ) {}

  /** List the tenant's schedules, soonest-due first. `org.manage`. */
  @Get('schedules')
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly schedules: readonly AutomationScheduleView[] }> {
    return { schedules: await this.schedules.list(context, principal) };
  }

  /** Record a schedule for a workflow template. `org.manage`. */
  @Post('templates/:templateId/schedule')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async schedule(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body: ScheduleBody,
  ): Promise<AutomationScheduleView> {
    requireTemplateId(templateId);
    const enabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined;
    return this.schedules.schedule(context, principal, templateId, body, {
      ...(enabled === undefined ? {} : { enabled }),
    });
  }

  /** Turn one schedule on or off (`{ enabled: boolean }`). `org.manage`. */
  @Patch('schedules/:scheduleId')
  @RequireCapability('org.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('scheduleId') scheduleId: string,
    @Body() body: ScheduleUpdateBody,
  ): Promise<AutomationScheduleView> {
    if (typeof body?.enabled !== 'boolean') {
      throw new ApiError(400, 'validation_failed', 'enabled must be true or false', [
        { field: 'enabled', message: 'must be a boolean' },
      ]);
    }
    return this.schedules.setEnabled(context, principal, scheduleId, body.enabled);
  }

  /** Remove one schedule. `org.manage`. */
  @Delete('schedules/:scheduleId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('scheduleId') scheduleId: string,
  ): Promise<void> {
    await this.schedules.remove(context, principal, scheduleId);
  }
}

/**
 * Automations scheduled triggers (x167). The module that wires the controller and its co-located
 * service. Registered in `app.module.ts` directly rather than folded into a shared automations module,
 * so this slice touches no file another automations slice in the same pass appends to.
 */
@Module({})
export class AutomationSchedulesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: AUTOMATION_SCHEDULES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new AutomationSchedulesService(database),
    };

    return {
      module: AutomationSchedulesModule,
      providers: [service],
      controllers: [AutomationSchedulesController],
    };
  }
}
