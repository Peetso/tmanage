import { Body, Controller, Get, Inject, Module, Param, Put } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import { PortalBrandingRepository } from './branding.repository.js';
import { PortalBrandingService } from './branding.service.js';

/**
 * SEC / Client portal branding (module 13, x323) — the internal write surface and the client
 * projection, keyed **per client organization** (not per project — that is `portal_settings`, x238).
 *
 * A studio sets one client's client-facing theme (accent colour, welcome heading, welcome text) once,
 * and every project shared with that client reads it. The design mirrors the portal-settings slice
 * (x238) and for the same reasons:
 *
 * - The **write** route (`PUT …/portal/branding/:clientOrganizationId`) is `client_member.manage` at
 *   an **internal** audience: `authorize()` denies any client principal an internal resource, so this
 *   is a staff-only write regardless of which client role a caller carries. The client-org scope is
 *   resolved tenant-scoped **before** the authorize, so an unknown or cross-tenant scope is a 404
 *   before any capability is weighed and before any write.
 * - The **read** route (`GET …/portal/branding/:clientOrganizationId`) serves the client projection
 *   ({@link PortalBrandingClientView}) behind `client_projection.read`: the presentation fields only,
 *   never `updatedBy` and never any internal stamp. A client reading a scope that is not their own is
 *   a 404 (not 403): a client probing scope ids must not learn which are real.
 *
 * The two controllers share one {@link PortalBrandingService}. Branding defaults when a client has
 * never been configured, so a resolvable scope always reads a branding object. Text and colour only
 * this slice — no logo upload.
 */

/** `welcome_heading` is VARCHAR(200); bound the accepted body to the column. */
const MAX_WELCOME_HEADING_LENGTH = 200;
/** `welcome_text` is VARCHAR(2000); bound the accepted body to the column. */
const MAX_WELCOME_TEXT_LENGTH = 2000;

/**
 * The accent-colour allowlist: a `#RGB` or `#RRGGBB` hex token, nothing else. A value that does not
 * match is a 400 before it reaches the service, so the branding accent cannot be pointed at an
 * arbitrary string, a CSS expression, or a colour keyword. Not a fixed palette (x238's posture) —
 * per-client branding accepts any valid hex — but the shape is enforced.
 */
export const ACCENT_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The default an unbranded client reads by — the same value the service fills. */
export const DEFAULT_PORTAL_BRANDING = {
  accentColor: '#2563eb',
  welcomeHeading: null,
  welcomeText: null,
} as const;

/**
 * A client's branding as an **internal** principal is shown it — the full record behind
 * `client_member.manage`. Carries `updatedBy`/`updatedAt`, the internal metadata a client must never
 * see; both are `null` until first configured. This view never leaves the internal write path.
 */
export interface PortalBrandingView {
  readonly clientOrganizationId: string;
  readonly accentColor: string;
  readonly welcomeHeading: string | null;
  readonly welcomeText: string | null;
  /** The staff member who last saved the branding. Internal-only; absent from the client view. */
  readonly updatedBy: string | null;
  /** An ISO-8601 instant, or null when never configured. Internal-only. */
  readonly updatedAt: string | null;
}

/**
 * A client's branding as the **client** is shown it — the client projection. What is absent is the
 * point: no `updatedBy`, no `updatedAt`, no scope id. The client receives only the presentation
 * fields.
 */
export interface PortalBrandingClientView {
  readonly accentColor: string;
  readonly welcomeHeading: string | null;
  readonly welcomeText: string | null;
}

/** What a caller saves. The tenant, the scope and the author come from context/path, never the body. */
export interface SavePortalBrandingCommand {
  readonly accentColor: string;
  readonly welcomeHeading: string | null;
  readonly welcomeText: string | null;
}

/**
 * Parse and validate a save body. Throws `validation_failed` (400) with field details for a malformed
 * accent colour, an oversize heading or an oversize text — decided before the service is touched, so
 * nothing is written on an invalid input.
 */
export function parseSaveBody(body: unknown): SavePortalBrandingCommand {
  const record = (body ?? {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];

  // Defaults to the base accent when absent; a value not matching the hex allowlist is a 400.
  const rawAccent = record['accentColor'];
  let accentColor: string = DEFAULT_PORTAL_BRANDING.accentColor;
  if (rawAccent !== undefined && rawAccent !== null) {
    if (typeof rawAccent === 'string' && ACCENT_COLOR_PATTERN.test(rawAccent)) {
      accentColor = rawAccent;
    } else {
      details.push({ field: 'accentColor', message: 'must be a #RGB or #RRGGBB hex colour' });
    }
  }

  const welcomeHeading = parseText(
    record['welcomeHeading'],
    'welcomeHeading',
    MAX_WELCOME_HEADING_LENGTH,
    details,
  );
  const welcomeText = parseText(
    record['welcomeText'],
    'welcomeText',
    MAX_WELCOME_TEXT_LENGTH,
    details,
  );

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { accentColor, welcomeHeading, welcomeText };
}

/** Optional bounded string. Absent, null or empty is stored as null; over-length is a 400. */
function parseText(
  raw: unknown,
  field: string,
  max: number,
  details: { field: string; message: string }[],
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    details.push({ field, message: 'must be a string or null' });
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    details.push({ field, message: `must be ${max} characters or fewer` });
    return null;
  }
  return trimmed === '' ? null : trimmed;
}

/** DI token for the service, private to this slice so no `tokens.ts` edit is needed. */
const PORTAL_BRANDING_SERVICE = Symbol.for('tmanage.PortalBrandingService');

/**
 * The internal portal-branding write surface — `client_member.manage`, on the `/portal/branding` path.
 * A client principal is denied at the internal audience the service authorizes against, so this is a
 * staff-only write; the service resolves the client-org scope tenant-scoped first (404 for an unknown
 * or cross-tenant scope) and only then authorizes.
 */
@Controller('v1/organizations/:orgSlug/portal/branding')
export class PortalBrandingController {
  constructor(@Inject(PORTAL_BRANDING_SERVICE) private readonly branding: PortalBrandingService) {}

  @Get(':clientOrganizationId')
  @RequireCapability('client_member.manage')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
  ): Promise<PortalBrandingView> {
    return this.branding.getInternal(context, principal, clientOrganizationId);
  }

  @Put(':clientOrganizationId')
  @RequireCapability('client_member.manage')
  async save(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
    @Body() body: unknown,
  ): Promise<PortalBrandingView> {
    return this.branding.save(context, principal, clientOrganizationId, parseSaveBody(body));
  }
}

/**
 * The client portal-branding projection — `client_projection.read`, on a `/portal/branding/client`
 * path of its own. Presentation fields only, no `updatedBy`; 404 (not 403) for a scope this client
 * does not own.
 */
@Controller('v1/organizations/:orgSlug/portal/branding/client')
export class PortalBrandingClientController {
  constructor(@Inject(PORTAL_BRANDING_SERVICE) private readonly branding: PortalBrandingService) {}

  @Get(':clientOrganizationId')
  @RequireCapability('client_projection.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
  ): Promise<PortalBrandingClientView> {
    return this.branding.getForClient(context, principal, clientOrganizationId);
  }
}

/**
 * SEC / Client portal branding (module 13, x323). Wires the two controllers and their shared service.
 * Registered in `app.module.ts` directly rather than folded into `ClientsModule`, so this slice
 * touches no file another clients-module slice appends to. It reuses `client_member.manage` (staff
 * write) and `client_projection.read` (client read), so it adds nothing to the capability files.
 */
@Module({})
export class PortalBrandingModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PORTAL_BRANDING_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new PortalBrandingService(
          database,
          new ClientOrganizationsRepository(),
          new PortalBrandingRepository(),
        ),
    };

    return {
      module: PortalBrandingModule,
      providers: [service],
      controllers: [PortalBrandingController, PortalBrandingClientController],
    };
  }
}
