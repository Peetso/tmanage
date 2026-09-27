import { Body, Controller, Get, HttpCode, Inject, Module, Post } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { authorize, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, Public, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MAINTENANCE_WINDOWS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import { MAINTENANCE_SEVERITIES } from '../../common/database/schema.js';
import type { MaintenanceWindowRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MaintenanceWindowsRepository } from './maintenance.repository.js';

/**
 * Platform states (x185) — the platform maintenance / degraded-mode window.
 *
 * `38-MODULE-MAP` §Platform states (maintenance); audit "Platform states Partial — maintenance/
 * degraded state absent". Two surfaces over one GLOBAL table (`maintenance_windows`, 0080):
 *
 *  - **Public read** — `GET /public/site/maintenance`, `@Public()`. The one thing the app shell
 *    reads before it knows anything else: is the platform in maintenance? It runs before the
 *    session/CSRF/tenant/capability pipeline, asks for no capability, resolves no tenant, and reads
 *    the GLOBAL table on the identity path. Only `published = 1` windows that have not yet ended are
 *    considered, and the response carries the current-or-next window (or none).
 *
 *  - **Admin write** — `POST /v1/organizations/:orgSlug/admin/maintenance`, `org.manage`. The flag is
 *    GLOBAL (platform-wide), so scheduling one is a platform-operator action; it is gated by
 *    `org.manage` on the org the operator names (`CapabilityGuard` refuses a caller without it with
 *    the ordinary 403 before the handler runs, and {@link AdminMaintenanceController.schedule}
 *    authorizes again — the audit-controller discipline). Authority is proved against the tenant; the
 *    row persists globally (`identityTransaction`). The write validates the `severity` enum and the
 *    `starts_at < ends_at` order, and a bad body is a 400 with no write.
 */

/** Column/severity bounds mirrored from `0080_maintenance_windows.sql`. Over-length is a 400. */
const MAX_MESSAGE = 4000;

/** The bounded number of windows the read considers — the current one and a few upcoming. */
export const MAX_MAINTENANCE_WINDOWS = 20;

/** One maintenance window, as both the public read and the admin write render it. */
export interface MaintenanceWindowView {
  readonly id: string;
  readonly message: string;
  readonly severity: (typeof MAINTENANCE_SEVERITIES)[number];
  readonly startsAt: string;
  readonly endsAt: string;
  /** `true` when `startsAt <= now < endsAt` — the banner shows; `false` for an upcoming window. */
  readonly active: boolean;
}

/** The public read's response: the current-or-next published window (or none), and the snapshot time. */
export interface PublicMaintenanceView {
  readonly window: MaintenanceWindowView | null;
  readonly asOf: string;
}

/** The admin write body. Untrusted, so every value is `unknown`; `Input` suffix keeps it request-side. */
interface ScheduleMaintenanceInput {
  readonly message?: unknown;
  readonly severity?: unknown;
  readonly startsAt?: unknown;
  readonly endsAt?: unknown;
  readonly published?: unknown;
}

@Controller('public/site')
export class PublicMaintenanceController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(MAINTENANCE_WINDOWS_REPOSITORY)
    private readonly repository: MaintenanceWindowsRepository,
  ) {}

  @Get('maintenance')
  @Public()
  async current(): Promise<PublicMaintenanceView> {
    const now = new Date();
    const rows = await this.database.identityRead(
      { correlationId: uuidv7(), tables: ['maintenance_windows'] },
      (runner) => this.repository.listPublishableWindows(runner, now, MAX_MAINTENANCE_WINDOWS),
    );
    return toPublicMaintenance(rows, now);
  }
}

@Controller('v1/organizations/:orgSlug/admin')
export class AdminMaintenanceController {
  constructor(
    @Inject(MAINTENANCE_WINDOWS_REPOSITORY)
    private readonly repository: MaintenanceWindowsRepository,
  ) {}

  @Post('maintenance')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async schedule(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: ScheduleMaintenanceInput,
  ): Promise<MaintenanceWindowView> {
    // Authorize first. The flag is platform-wide, so writing it is `org.manage` on the platform org;
    // the guard already refused a caller without it, and this is the service-level re-check the
    // audit controller documents. An unauthorized caller never reaches validation.
    this.requireOrgManage(principal, context);

    const now = new Date();
    const message = boundedText(body?.message, MAX_MESSAGE);
    const severity = asSeverity(body?.severity);
    const startsAt = asInstant(body?.startsAt);
    const endsAt = asInstant(body?.endsAt);
    const published = body?.published === undefined ? true : asBoolean(body?.published);

    const details: { field: string; message: string }[] = [];
    if (message === undefined)
      details.push({ field: 'message', message: `required, 1–${MAX_MESSAGE} chars` });
    if (severity === undefined)
      details.push({ field: 'severity', message: `one of ${MAINTENANCE_SEVERITIES.join(', ')}` });
    if (startsAt === undefined)
      details.push({ field: 'startsAt', message: 'required ISO-8601 instant' });
    if (endsAt === undefined)
      details.push({ field: 'endsAt', message: 'required ISO-8601 instant' });
    if (published === undefined) details.push({ field: 'published', message: 'must be a boolean' });
    if (startsAt !== undefined && endsAt !== undefined && startsAt.getTime() >= endsAt.getTime()) {
      details.push({ field: 'endsAt', message: 'endsAt must be after startsAt' });
    }

    if (
      details.length > 0 ||
      message === undefined ||
      severity === undefined ||
      startsAt === undefined ||
      endsAt === undefined ||
      published === undefined
    ) {
      // A shape error, not an authorization one, so it is specific. Nothing is written: the
      // repository is not reached on this path.
      throw new ApiError(400, 'validation_failed', 'The maintenance window is invalid', details);
    }

    const inserted = await this.repository.insert({
      message,
      severity,
      startsAt,
      endsAt,
      published,
      correlationId: uuidv7(),
    });

    return toMaintenanceWindowView(
      {
        id: inserted.id,
        message,
        severity,
        startsAt,
        endsAt,
        published,
        createdAt: inserted.createdAt,
      },
      now,
    );
  }

  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Null: this is an org-level (indeed platform-level) resource, not a project one.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        'You do not have permission to manage maintenance windows',
        undefined,
        `maintenance.schedule:${verdict.code}`,
      );
    }
  }
}

/**
 * Map the published, not-yet-ended windows to the public snapshot as pure logic, so the behaviour is
 * provable without a database. The rows arrive soonest-starting first; the head is the current window
 * if one is running, otherwise the next scheduled one. `active` re-applies the `startsAt <= now < endsAt`
 * boundary so a caller cannot be told a future window is live.
 */
export function toPublicMaintenance(
  rows: readonly MaintenanceWindowRow[],
  now: Date,
): PublicMaintenanceView {
  const visible = rows
    .filter((row) => row.published && row.endsAt.getTime() > now.getTime())
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const head = visible[0];
  return {
    window: head === undefined ? null : toMaintenanceWindowView(head, now),
    asOf: now.toISOString(),
  };
}

function toMaintenanceWindowView(row: MaintenanceWindowRow, now: Date): MaintenanceWindowView {
  return {
    id: row.id,
    message: row.message,
    severity: row.severity,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    active: row.startsAt.getTime() <= now.getTime() && now.getTime() < row.endsAt.getTime(),
  };
}

/** A trimmed 1..=max string, or `undefined` when absent, non-string, empty or over-length. */
function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/** The value narrowed to a known severity, or `undefined` for anything outside the closed set. */
function asSeverity(value: unknown): (typeof MAINTENANCE_SEVERITIES)[number] | undefined {
  return typeof value === 'string' && (MAINTENANCE_SEVERITIES as readonly string[]).includes(value)
    ? (value as (typeof MAINTENANCE_SEVERITIES)[number])
    : undefined;
}

/** A real instant parsed from an ISO-8601 string, or `undefined` for a non-string or unparsable value. */
function asInstant(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** A boolean, or `undefined` for anything else (a missing default is applied by the caller). */
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Platform states (x185). Wires the two maintenance controllers over one stateless repository.
 *
 * The public read depends only on the GLOBAL `TENANT_DATABASE` (identity path); the admin write is
 * capability-gated by the global guards. Following the `InsightsAdoptionModule` precedent, the module
 * lives beside its controllers rather than in a file of its own.
 */
@Module({})
export class MaintenanceModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: MAINTENANCE_WINDOWS_REPOSITORY,
      useFactory: (database: TenantDatabase) => new MaintenanceWindowsRepository(database),
      inject: [TENANT_DATABASE],
    };

    return {
      module: MaintenanceModule,
      providers: [repository],
      controllers: [PublicMaintenanceController, AdminMaintenanceController],
    };
  }
}
