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
  Req,
  UseGuards,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import {
  API_CONFIG,
  MAINTENANCE_WINDOWS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import { MAINTENANCE_SEVERITIES } from '../../common/database/schema.js';
import type { MaintenanceWindowRow } from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  optionalReason,
  platformRequestContext,
  requireId,
  requireReason,
} from '../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PLATFORM_ADMIN_ALLOWLIST,
  PLATFORM_ADMIN_LOOKUP,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { PlatformAdminRepository } from '../platform-admin/platform-admin.repository.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import { PublicSiteAnnouncementsController } from '../public-site/site-announcements.controller.js';
import { PlatformAnnouncementsRepository } from '../platform-admin/settings/announcements.repository.js';
import { MaintenanceWindowsRepository } from './maintenance.repository.js';
import type { MaintenanceWindowRecord } from './maintenance.repository.js';

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
 *  - **Operator write** — `POST /v1/platform/maintenance` and `POST /v1/platform/maintenance/:id/
 *    unpublish`, `@NoTenant()` behind `PlatformAdminGuard` (wave 9 S8, audit F07). The flag is GLOBAL,
 *    so only the platform operator may set it; no organization role (owner included) reaches these
 *    routes. Each write needs a typed reason and commits with its platform audit row. The write
 *    validates the `severity` enum and the `starts_at < ends_at` order; a bad body is a 400 with no
 *    write.
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
  // ---- platform-admin v2 · PA-10 ----
  /** The Arabic message (0244), when one was written. */
  readonly messageAr?: string;
}

/** The public read's response: the current-or-next published window (or none), and the snapshot time. */
export interface PublicMaintenanceView {
  readonly window: MaintenanceWindowView | null;
  readonly asOf: string;
}

/** The operator write body. Untrusted, so every value is `unknown`; `Input` suffix keeps it request-side. */
interface ScheduleMaintenanceInput {
  readonly reason?: unknown;
  readonly message?: unknown;
  readonly severity?: unknown;
  readonly startsAt?: unknown;
  readonly endsAt?: unknown;
  readonly published?: unknown;
  // ---- platform-admin v2 · PA-10 ----
  readonly messageAr?: unknown;
  readonly blockSignIn?: unknown;
}

// ---- platform-admin v2 · PA-10 ----

/** D4: one window as the operator's screen shows it, with every 0244 column and its state. */
export interface PlatformMaintenanceWindowView {
  readonly id: string;
  readonly message: string;
  readonly messageAr: string | null;
  readonly severity: (typeof MAINTENANCE_SEVERITIES)[number];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly published: boolean;
  readonly blockSignIn: boolean;
  /** `draft` (not published), `scheduled`, `active` (running now) or `ended`. */
  readonly state: 'draft' | 'scheduled' | 'active' | 'ended';
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

/** D4: the windows, the running one (if any) for the status card, and the snapshot time. */
export interface PlatformMaintenanceListView {
  readonly windows: readonly PlatformMaintenanceWindowView[];
  readonly current: PlatformMaintenanceWindowView | null;
  readonly asOf: string;
}

/** The most windows the D4 list shows. */
export const MAX_ADMIN_WINDOWS = 100;

/** The state of one window at `now`. Pure. */
export function maintenanceState(
  record: Pick<MaintenanceWindowRecord, 'published' | 'startsAt' | 'endsAt' | 'endedAt'>,
  now: Date,
): PlatformMaintenanceWindowView['state'] {
  if (record.endedAt !== null || record.endsAt.getTime() <= now.getTime()) return 'ended';
  if (!record.published) return 'draft';
  return record.startsAt.getTime() <= now.getTime() ? 'active' : 'scheduled';
}

export function toPlatformMaintenanceView(
  record: MaintenanceWindowRecord,
  now: Date,
): PlatformMaintenanceWindowView {
  return {
    id: record.id,
    message: record.message,
    messageAr: record.messageAr,
    severity: record.severity,
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    published: record.published,
    blockSignIn: record.blockSignIn,
    state: maintenanceState(record, now),
    endedAt: record.endedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt?.toISOString() ?? null,
  };
}

/**
 * The maintenance message for a sign-in refusal, in the person's language when an Arabic one was
 * written (`Accept-Language: ar…`).
 */
export function maintenanceMessageFor(
  record: Pick<MaintenanceWindowRecord, 'message' | 'messageAr'>,
  acceptLanguage: unknown,
): string {
  const arabic = typeof acceptLanguage === 'string' && /^\s*ar\b/iu.test(acceptLanguage);
  return arabic && record.messageAr ? record.messageAr : record.message;
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
    const view = toPublicMaintenance(rows, now);
    // PA-10: the Arabic message (0244) rides along when one was written.
    if (view.window && typeof this.repository.find === 'function') {
      const record = await this.repository.find(view.window.id, uuidv7());
      if (record?.messageAr)
        return { ...view, window: { ...view.window, messageAr: record.messageAr } };
    }
    return view;
  }
}

/**
 * F07 (wave 9, S8) — the platform operator's maintenance surface. `@NoTenant()`: no organization is
 * resolved and no organization role is consulted, so an owner of every company is refused exactly
 * like a stranger. `PlatformAdminGuard` is the whole of the authorization (listed, verified email,
 * browser session, fresh step-up); the old tenant route `POST /v1/organizations/:orgSlug/admin/
 * maintenance` no longer exists. Every write carries a typed reason into the platform audit log in
 * the same transaction as the window change.
 */
@Controller('v1/platform/maintenance')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformMaintenanceController {
  constructor(
    @Inject(MAINTENANCE_WINDOWS_REPOSITORY)
    private readonly repository: MaintenanceWindowsRepository,
  ) {}

  /** D4: every window with its state, and the running one for the status card. */
  @Get()
  @RequirePlatformPermission('platform.orgs.view')
  async list(@Req() request: object): Promise<PlatformMaintenanceListView> {
    const now = new Date();
    const rows = await this.repository.listAll(
      MAX_ADMIN_WINDOWS,
      requireRequestState(request).correlationId,
    );
    const windows = rows.map((row) => toPlatformMaintenanceView(row, now));
    return {
      windows,
      current: windows.find((window) => window.state === 'active') ?? null,
      asOf: now.toISOString(),
    };
  }

  @Post()
  @HttpCode(201)
  @RequirePlatformPermission('platform.announcements.edit')
  async schedule(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: ScheduleMaintenanceInput,
    @Req() request: object,
  ): Promise<MaintenanceWindowView> {
    const now = new Date();
    const message = boundedText(body?.message, MAX_MESSAGE);
    const severity = asSeverity(body?.severity);
    const startsAt = asInstant(body?.startsAt);
    const endsAt = asInstant(body?.endsAt);
    const published = body?.published === undefined ? true : asBoolean(body?.published);
    const messageAr = optionalText(body?.messageAr, MAX_MESSAGE);
    const blockSignIn = body?.blockSignIn === undefined ? false : asBoolean(body?.blockSignIn);

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
    if (messageAr === false)
      details.push({ field: 'messageAr', message: `at most ${MAX_MESSAGE} chars` });
    if (blockSignIn === undefined)
      details.push({ field: 'blockSignIn', message: 'must be a boolean' });

    if (
      messageAr === false ||
      blockSignIn === undefined ||
      details.length > 0 ||
      message === undefined ||
      severity === undefined ||
      startsAt === undefined ||
      endsAt === undefined ||
      published === undefined
    ) {
      // A shape error, not an authorization one, so it is specific. Nothing is written.
      throw new ApiError(400, 'validation_failed', 'The maintenance window is invalid', details);
    }
    // The typed reason is required (400, nothing written), like every platform action.
    const reason = requireReason(body?.reason);

    const inserted = await this.repository.schedule(
      { message, severity, startsAt, endsAt, published, messageAr, blockSignIn },
      {
        actorUserId: actor.account.userId,
        actorEmail: actor.account.email,
        action: 'platform.maintenance_scheduled',
        targetLabel: severity,
        reason,
        correlationId: requireRequestState(request).correlationId,
      },
    );

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

  /** Take a window off the banner. Unknown id is a 404 with nothing written. Audited with the reason. */
  @Post(':windowId/unpublish')
  @HttpCode(200)
  @RequirePlatformPermission('platform.announcements.edit')
  async unpublish(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('windowId') windowId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ): Promise<{ readonly unpublished: true }> {
    const id = requireId(windowId);
    const reason = requireReason(body?.reason);
    const found = await this.repository.unpublish(id, {
      actorUserId: actor.account.userId,
      actorEmail: actor.account.email,
      action: 'platform.maintenance_unpublished',
      targetLabel: null,
      reason,
      correlationId: requireRequestState(request).correlationId,
    });
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { unpublished: true };
  }

  // ---- platform-admin v2 · PA-10 ----

  /** D4 edit: the whole window (EN + AR message, severity, window, publish, block sign-in). */
  @Patch(':windowId')
  @HttpCode(200)
  @RequirePlatformPermission('platform.announcements.edit')
  async edit(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('windowId') windowId: string,
    @Body() body: ScheduleMaintenanceInput,
    @Req() request: object,
  ): Promise<PlatformMaintenanceWindowView> {
    const id = requireId(windowId);
    const context = platformRequestContext(request);
    const existing = await this.repository.find(id, context.correlationId);
    if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const message =
      body?.message === undefined ? existing.message : boundedText(body.message, MAX_MESSAGE);
    const messageAr =
      body?.messageAr === undefined
        ? existing.messageAr
        : optionalText(body.messageAr, MAX_MESSAGE);
    const severity = body?.severity === undefined ? existing.severity : asSeverity(body.severity);
    const startsAt = body?.startsAt === undefined ? existing.startsAt : asInstant(body.startsAt);
    const endsAt = body?.endsAt === undefined ? existing.endsAt : asInstant(body.endsAt);
    const published =
      body?.published === undefined ? existing.published : asBoolean(body.published);
    const blockSignIn =
      body?.blockSignIn === undefined ? existing.blockSignIn : asBoolean(body.blockSignIn);
    const details: { field: string; message: string }[] = [];
    if (message === undefined)
      details.push({ field: 'message', message: `required, 1–${MAX_MESSAGE} chars` });
    if (messageAr === false)
      details.push({ field: 'messageAr', message: `at most ${MAX_MESSAGE} chars` });
    if (severity === undefined)
      details.push({ field: 'severity', message: `one of ${MAINTENANCE_SEVERITIES.join(', ')}` });
    if (startsAt === undefined)
      details.push({ field: 'startsAt', message: 'required ISO-8601 instant' });
    if (endsAt === undefined)
      details.push({ field: 'endsAt', message: 'required ISO-8601 instant' });
    if (published === undefined) details.push({ field: 'published', message: 'must be a boolean' });
    if (blockSignIn === undefined)
      details.push({ field: 'blockSignIn', message: 'must be a boolean' });
    if (startsAt !== undefined && endsAt !== undefined && startsAt.getTime() >= endsAt.getTime()) {
      details.push({ field: 'endsAt', message: 'endsAt must be after startsAt' });
    }
    if (
      details.length > 0 ||
      message === undefined ||
      messageAr === false ||
      severity === undefined ||
      startsAt === undefined ||
      endsAt === undefined ||
      published === undefined ||
      blockSignIn === undefined
    ) {
      throw new ApiError(400, 'validation_failed', 'The maintenance window is invalid', details);
    }
    const reason = optionalReason(body?.reason);
    const next = { message, messageAr, severity, startsAt, endsAt, published, blockSignIn };
    await this.repository.update(
      id,
      next,
      platformAuditFor(actor, context, {
        action: 'platform.maintenance_updated',
        targetType: 'platform',
        targetId: id,
        targetLabel: severity,
        reason,
        beforeJson: JSON.stringify(auditShape(existing)),
        afterJson: JSON.stringify(auditShape(next)),
      }),
    );
    const updated = await this.repository.find(id, context.correlationId);
    if (!updated) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return toPlatformMaintenanceView(updated, new Date());
  }

  /** D4 publish. Reason optional. */
  @Post(':windowId/publish')
  @HttpCode(200)
  @RequirePlatformPermission('platform.announcements.edit')
  async publish(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('windowId') windowId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ): Promise<PlatformMaintenanceWindowView> {
    const id = requireId(windowId);
    const context = platformRequestContext(request);
    const reason = optionalReason(body?.reason);
    const found = await this.repository.setPublished(
      id,
      true,
      platformAuditFor(actor, context, {
        action: 'platform.maintenance_published',
        targetType: 'platform',
        targetId: id,
        targetLabel: null,
        reason,
      }),
    );
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const record = await this.repository.find(id, context.correlationId);
    if (!record) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return toPlatformMaintenanceView(record, new Date());
  }

  /**
   * D4 "End now" (frame 440:20171): the banner disappears and sign-in opens for everyone at once.
   * Reason optional (as drawn); audited.
   */
  @Post(':windowId/end')
  @HttpCode(200)
  @RequirePlatformPermission('platform.announcements.edit')
  async end(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('windowId') windowId: string,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ): Promise<PlatformMaintenanceWindowView> {
    const id = requireId(windowId);
    const context = platformRequestContext(request);
    const reason = optionalReason(body?.reason);
    const now = new Date();
    const found = await this.repository.end(
      id,
      now,
      platformAuditFor(actor, context, {
        action: 'platform.maintenance_ended',
        targetType: 'platform',
        targetId: id,
        targetLabel: null,
        reason,
      }),
    );
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const record = await this.repository.find(id, context.correlationId);
    if (!record) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return toPlatformMaintenanceView(record, now);
  }
}

/** The fields an audit row records for a maintenance edit (no ids, no timestamps). */
function auditShape(record: {
  message: string;
  messageAr: string | null;
  severity: string;
  startsAt: Date;
  endsAt: Date;
  published: boolean;
  blockSignIn: boolean;
}) {
  return {
    message: record.message,
    messageAr: record.messageAr,
    severity: record.severity,
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    published: record.published,
    blockSignIn: record.blockSignIn,
  };
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

function toMaintenanceWindowView(
  row: MaintenanceWindowRow & { readonly messageAr?: string | null },
  now: Date,
): MaintenanceWindowView {
  return {
    id: row.id,
    message: row.message,
    severity: row.severity,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    active: row.startsAt.getTime() <= now.getTime() && now.getTime() < row.endsAt.getTime(),
    ...(row.messageAr ? { messageAr: row.messageAr } : {}),
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

/**
 * PA-10: an optional text — `null` when absent or empty, the trimmed string when it fits, `false`
 * when it is not a string or is over-length (a 400).
 */
function optionalText(value: unknown, max: number): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? false : trimmed;
}

/** A boolean, or `undefined` for anything else (a missing default is applied by the caller). */
function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Platform states (x185). Wires the two maintenance controllers over one stateless repository.
 *
 * The public read depends only on the GLOBAL `TENANT_DATABASE` (identity path); the operator write
 * is gated by `PlatformAdminGuard` (F07). Following the `InsightsAdoptionModule` precedent, the module
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

    // F07: the operator gate, built the way `PlatformAdminModule` builds it. An unset
    // `PLATFORM_ADMIN_EMAILS` is an empty list, which the guard refuses with the ordinary 404.
    const lookup: Provider = {
      provide: PLATFORM_ADMIN_LOOKUP,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PlatformAdminRepository(database),
    };
    const allowlist: Provider = {
      provide: PLATFORM_ADMIN_ALLOWLIST,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => config.platformAdminEmails ?? [],
    };

    // ---- platform-admin v2 · PA-10 ---- the public announcement read sits beside the public
    // maintenance read (`GET /public/site/announcements`), over the same global identity path.
    const announcements: Provider = {
      provide: PlatformAnnouncementsRepository,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PlatformAnnouncementsRepository(database),
    };

    return {
      module: MaintenanceModule,
      providers: [repository, lookup, allowlist, PlatformAdminGuard, announcements],
      controllers: [
        PublicMaintenanceController,
        PlatformMaintenanceController,
        PublicSiteAnnouncementsController,
      ],
    };
  }
}

// ---- platform-admin v2 · PA-10 ----

/**
 * The maintenance sign-in gate (SPEC §4 D4): while a published `down` window with
 * `block_sign_in = 1` is running, sign-in is refused for everyone except platform admins (the
 * server list ∪ active `platform_admins` rows). Called by `authentication.controller.ts` right
 * before a session is created, so a refused person gets no session and sees the maintenance
 * message (Arabic when the browser asks for it and one was written).
 *
 * A failed read lets the sign-in through: the gate protects a maintenance window, and a database
 * that cannot answer this question will refuse the sign-in on its own anyway.
 */
export async function assertSignInOpen(
  database: TenantDatabase,
  allowlist: readonly string[],
  input: {
    readonly userId: string;
    readonly acceptLanguage: unknown;
    readonly correlationId: string;
  },
): Promise<void> {
  let block: MaintenanceWindowRecord | null;
  try {
    block = await new MaintenanceWindowsRepository(database).activeSignInBlock(
      new Date(),
      input.correlationId,
    );
  } catch {
    return;
  }
  if (!block) return;
  const admins = new PlatformAdminRepository(database);
  const account = await admins.findAccount(input.userId, input.correlationId);
  if (account?.emailVerified) {
    if (allowlist.includes(account.email.trim().toLowerCase())) return;
    const row = await admins.findPlatformAdmin(input.userId, input.correlationId);
    if (row?.status === 'active') return;
  }
  throw new ApiError(
    403,
    'forbidden',
    maintenanceMessageFor(block, input.acceptLanguage),
    undefined,
    'maintenance_sign_in_blocked',
  );
}
