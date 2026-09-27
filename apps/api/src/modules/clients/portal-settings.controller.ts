import { Body, Controller, Get, Inject, Module, Param, Put } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { PortalSettingsRepository } from './portal-settings.repository.js';
import { PortalSettingsService } from './portal-settings.service.js';

/**
 * SEC / Client portal settings (module 13, x238) — the internal read/write surface and the client
 * projection.
 *
 * The design mirrors the portal risks slice (x140) and for the same reasons:
 *
 * - The **internal** routes (`GET`/`PUT …/projects/:projectId/portal-settings`) live on the internal
 *   `projects` path behind `project.manage`, which no client role holds. Keeping the read and the
 *   write off `/portal` means a client principal never reaches them — a security property, not a
 *   routing preference. The internal read carries `updatedBy` (which staff member last edited), the
 *   one field a client must never see.
 * - The **client** route (`GET …/portal/projects/:projectId/portal-settings`) is on a path of its own
 *   and serves the client projection ({@link PortalSettingsClientView}) — the presentation fields
 *   only (welcome message, accent, the two toggles), never `updatedBy` and never any internal stamp.
 *
 * The two controllers share one {@link PortalSettingsService}: the project is resolved tenant-scoped
 * and relation-checked there, and the settings store reads or upserts against it. Settings default
 * when a project has never been configured, so a resolvable project always reads a settings object.
 */

/** `portal_settings.welcome_message` is VARCHAR(2000); bound the accepted body to the column. */
const MAX_WELCOME_MESSAGE_LENGTH = 2000;

/**
 * The fixed accent palette. `accent_color` is stored as a hex token but only ever one of these — a
 * value outside the palette is a 400 before it reaches the engine, so the portal's branding cannot be
 * pointed at an arbitrary colour. The first entry is the default an unconfigured project reads by.
 */
export const PORTAL_ACCENT_PALETTE = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#dc2626',
  '#d97706',
  '#059669',
  '#0891b2',
  '#4b5563',
] as const;

export type PortalAccentColor = (typeof PORTAL_ACCENT_PALETTE)[number];

/** The default settings an unconfigured project reads by — the same values the service fills. */
export const DEFAULT_PORTAL_SETTINGS = {
  welcomeMessage: null,
  accentColor: PORTAL_ACCENT_PALETTE[0],
  showTeam: true,
  showTimeline: true,
} as const;

/**
 * A project's portal settings as an **internal** principal is shown them — the full record behind
 * `project.manage`.
 *
 * Carries `updatedBy` (which staff member last saved the settings) and `updatedAt`, the internal
 * metadata a client must never see. Both are `null` until the project is first configured. This view
 * never leaves the internal `projects` path.
 */
export interface PortalSettingsView {
  readonly projectId: string;
  readonly welcomeMessage: string | null;
  readonly accentColor: string;
  readonly showTeam: boolean;
  readonly showTimeline: boolean;
  /** The staff member who last saved the settings. Internal-only; absent from the client view. */
  readonly updatedBy: string | null;
  /** An ISO-8601 instant, or null when never configured. Internal-only. */
  readonly updatedAt: string | null;
}

/**
 * A project's portal settings as a **client** is shown them — the client projection.
 *
 * What is absent is the point: **`updatedBy` is not here** (which member of the agency edited the
 * branding is never learned — the staff-identity exclusion `12-PERMISSION-MATRIX` §4 makes), and
 * neither is `updatedAt` nor `projectId`. The client receives only the presentation fields.
 */
export interface PortalSettingsClientView {
  readonly welcomeMessage: string | null;
  readonly accentColor: string;
  readonly showTeam: boolean;
  readonly showTimeline: boolean;
}

/** What an internal principal saves. The tenant and the author come from the context, never the body. */
export interface SavePortalSettingsCommand {
  readonly welcomeMessage: string | null;
  readonly accentColor: PortalAccentColor;
  readonly showTeam: boolean;
  readonly showTimeline: boolean;
}

/** `true` when `value` is one of the fixed accent-palette tokens. */
export function isPortalAccentColor(value: unknown): value is PortalAccentColor {
  return typeof value === 'string' && (PORTAL_ACCENT_PALETTE as readonly string[]).includes(value);
}

/**
 * Parse and validate a save body. Throws `validation_failed` (400) with field details for an
 * off-palette accent, an oversize welcome message, or a non-boolean toggle — decided before the
 * service is touched, so nothing is written on an invalid input.
 */
export function parseSaveBody(body: unknown): SavePortalSettingsCommand {
  const record = (body ?? {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];

  // Optional. Absent, null or empty is stored as null (the project shows the default, no message).
  const rawWelcome = record['welcomeMessage'];
  let welcomeMessage: string | null = null;
  if (rawWelcome !== undefined && rawWelcome !== null) {
    if (typeof rawWelcome === 'string') {
      const trimmed = rawWelcome.trim();
      if (trimmed.length > MAX_WELCOME_MESSAGE_LENGTH) {
        details.push({
          field: 'welcomeMessage',
          message: `must be ${MAX_WELCOME_MESSAGE_LENGTH} characters or fewer`,
        });
      } else {
        welcomeMessage = trimmed === '' ? null : trimmed;
      }
    } else {
      details.push({ field: 'welcomeMessage', message: 'must be a string or null' });
    }
  }

  // Defaults to the first palette entry when absent; an off-palette value is a 400.
  const rawAccent = record['accentColor'];
  let accentColor: PortalAccentColor = DEFAULT_PORTAL_SETTINGS.accentColor;
  if (rawAccent !== undefined) {
    if (isPortalAccentColor(rawAccent)) {
      accentColor = rawAccent;
    } else {
      details.push({
        field: 'accentColor',
        message: `must be one of ${PORTAL_ACCENT_PALETTE.join(', ')}`,
      });
    }
  }

  const showTeam = parseToggle(
    record['showTeam'],
    'showTeam',
    details,
    DEFAULT_PORTAL_SETTINGS.showTeam,
  );
  const showTimeline = parseToggle(
    record['showTimeline'],
    'showTimeline',
    details,
    DEFAULT_PORTAL_SETTINGS.showTimeline,
  );

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { welcomeMessage, accentColor, showTeam, showTimeline };
}

function parseToggle(
  raw: unknown,
  field: string,
  details: { field: string; message: string }[],
  fallback: boolean,
): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'boolean') {
    details.push({ field, message: 'must be a boolean' });
    return fallback;
  }
  return raw;
}

/** DI token for the service, private to this slice so no `tokens.ts` edit is needed (the schedules
 * posture). Declared before the controllers so their `@Inject` decorators can reference it. */
const PORTAL_SETTINGS_SERVICE = Symbol.for('tmanage.PortalSettingsService');

/**
 * The internal portal-settings surface — `project.manage`, on the `projects` path. A client principal
 * never holds `project.manage`, so `CapabilityGuard` refuses them here with 403 before the handler
 * runs; the service applies the object-level decision (404 for a project they cannot manage). The read
 * carries `updatedBy`, so it never leaves this path.
 */
@Controller('v1/organizations/:orgSlug/projects')
export class PortalSettingsController {
  constructor(@Inject(PORTAL_SETTINGS_SERVICE) private readonly settings: PortalSettingsService) {}

  @Get(':projectId/portal-settings')
  @RequireCapability('project.manage')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<PortalSettingsView> {
    return this.settings.getInternal(context, principal, projectId);
  }

  @Put(':projectId/portal-settings')
  @RequireCapability('project.manage')
  async save(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<PortalSettingsView> {
    return this.settings.save(context, principal, projectId, parseSaveBody(body));
  }
}

/**
 * The client portal-settings projection — `client_projection.read`, on the `/portal` path. Presentation
 * fields only, no `updatedBy`; 404 (not 403, not an empty body) for a project this client cannot read.
 */
@Controller('v1/organizations/:orgSlug/portal')
export class PortalSettingsClientController {
  constructor(@Inject(PORTAL_SETTINGS_SERVICE) private readonly settings: PortalSettingsService) {}

  @Get('projects/:projectId/portal-settings')
  @RequireCapability('client_projection.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<PortalSettingsClientView> {
    return this.settings.getForClient(context, principal, projectId);
  }
}

/**
 * SEC / Client portal settings (module 13, x238). The module that wires the two controllers and their
 * shared service. Registered in `app.module.ts` directly rather than folded into `ClientsModule`, so
 * this slice touches no file another clients-module slice in the same pass appends to. It reuses
 * `project.manage` (internal) and `client_projection.read` (client), so it adds nothing to the
 * capability files.
 */
@Module({})
export class PortalSettingsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PORTAL_SETTINGS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new PortalSettingsService(
          database,
          new ProjectsRepository(),
          new PortalSettingsRepository(),
        ),
    };

    return {
      module: PortalSettingsModule,
      providers: [service],
      controllers: [PortalSettingsController, PortalSettingsClientController],
    };
  }
}
