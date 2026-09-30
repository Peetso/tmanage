import { Body, Controller, Get, Inject, Module, Put } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  ORG_BRANDING_LOGO_TEXT_MAX_LENGTH,
  ORG_BRANDING_PRODUCT_NAME_MAX_LENGTH,
} from '../../common/database/schema.js';
import { OrgBrandingRepository } from './org-branding.repository.js';
import { OrgBrandingService } from './org-branding.service.js';

/**
 * ADM / org identity (Administration, module 18, x327) — org-wide branding for the *internal* app
 * chrome. An org admin sets the display product name, an accent colour and a short logo text /
 * initials; any member reads it to render the app shell. Text and colour only — no file upload this
 * slice. One row per organization.
 *
 * Two surfaces, deliberately split:
 *
 * - The **set** route (`PUT …/admin/branding`) lives on the internal `admin` path behind `org.manage`,
 *   which no client role and no ordinary member holds — `CapabilityGuard` refuses them with 403 before
 *   the handler runs. The service *also* runs the real tenant-checked `authorize` for `org.manage`, so
 *   the refusal is a rule a controller test proves directly.
 * - The **read** route (`GET …/branding`) is behind `work.read`, the capability every authenticated
 *   member holds (a client principal does not), so any member resolves the chrome. The read carries
 *   `updatedBy`/`updatedAt` — internal metadata, and the read is an internal-member surface, never a
 *   client one.
 *
 * Distinct from `portal_settings` (x238, per-project, client-facing) and from `org_settings`
 * (behaviour flags). It reuses `org.manage` and `work.read`, so it adds nothing to the capability
 * files.
 */

/**
 * The accent-colour allowlist: a hex token, either `#RGB` or `#RRGGBB`. Stored as a hex string but only
 * ever one that matches this shape — anything else is a 400 before it reaches the engine, so the chrome
 * accent cannot be pointed at an arbitrary string.
 */
export const ORG_BRANDING_ACCENT_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** The default branding an unconfigured studio reads by — the same values the service fills. */
export const DEFAULT_ORG_BRANDING = {
  productName: null,
  accentColor: '#2563eb',
  logoText: null,
} as const;

/**
 * The org's branding as it is exchanged on the internal routes — the presentation fields plus the
 * internal stamps. `updatedBy`/`updatedAt` are `null` until the studio first configures its branding.
 */
export interface OrgBrandingView {
  readonly productName: string | null;
  readonly accentColor: string;
  readonly logoText: string | null;
  /** The member who last saved the branding. Internal metadata. */
  readonly updatedBy: string | null;
  /** An ISO-8601 instant, or null when never configured. */
  readonly updatedAt: string | null;
}

/** What an admin saves. The tenant and the author come from the context, never the body. */
export interface SaveOrgBrandingCommand {
  readonly productName: string | null;
  readonly accentColor: string;
  readonly logoText: string | null;
}

/** `true` when `value` is a hex accent token of the allowed shape. */
export function isOrgBrandingAccentColor(value: unknown): value is string {
  return typeof value === 'string' && ORG_BRANDING_ACCENT_PATTERN.test(value);
}

/**
 * Parse and validate a save body. Throws `validation_failed` (400) with field details for a malformed
 * accent colour, an over-length product name, or an over-length logo text — decided before the service
 * is touched, so nothing is written (no upsert) on an invalid input. An absent/empty product name or
 * logo text is stored as null (the studio shows the default); an absent accent defaults to the palette
 * base.
 */
export function parseSaveBody(body: unknown): SaveOrgBrandingCommand {
  const record = (body ?? {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];

  const productName = parseOptionalText(
    record['productName'],
    'productName',
    ORG_BRANDING_PRODUCT_NAME_MAX_LENGTH,
    details,
  );
  const logoText = parseOptionalText(
    record['logoText'],
    'logoText',
    ORG_BRANDING_LOGO_TEXT_MAX_LENGTH,
    details,
  );

  // Defaults to the palette base when absent; a malformed value is a 400 (no upsert).
  const rawAccent = record['accentColor'];
  let accentColor: string = DEFAULT_ORG_BRANDING.accentColor;
  if (rawAccent !== undefined) {
    if (isOrgBrandingAccentColor(rawAccent)) {
      accentColor = rawAccent;
    } else {
      details.push({ field: 'accentColor', message: 'must be a hex colour (#RGB or #RRGGBB)' });
    }
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { productName, accentColor, logoText };
}

/** Optional bounded text: absent/null/empty → null; a non-string or over-length value is a 400. */
function parseOptionalText(
  raw: unknown,
  field: string,
  maxLength: number,
  details: { field: string; message: string }[],
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    details.push({ field, message: 'must be a string or null' });
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length > maxLength) {
    details.push({ field, message: `must be ${maxLength} characters or fewer` });
    return null;
  }
  return trimmed === '' ? null : trimmed;
}

/** DI token for the service, private to this slice so no `tokens.ts` edit is needed. */
const ORG_BRANDING_SERVICE = Symbol.for('tmanage.OrgBrandingService');

/**
 * The admin set surface — `org.manage`, on the `admin` path. No client role and no ordinary member
 * holds `org.manage`, so `CapabilityGuard` refuses them with 403 before the handler runs; the service
 * applies the tenant-checked decision (404 for a cross-tenant org, 403 for a caller without the cap).
 */
@Controller('v1/organizations/:orgSlug/admin/branding')
export class AdminOrgBrandingController {
  constructor(@Inject(ORG_BRANDING_SERVICE) private readonly branding: OrgBrandingService) {}

  @Put()
  @RequireCapability('org.manage')
  async save(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<OrgBrandingView> {
    return this.branding.set(context, principal, parseSaveBody(body));
  }
}

/**
 * The member read surface — `work.read`, on the org root `branding` path. Every authenticated member
 * holds `work.read` and resolves the chrome; a client principal does not and is refused. Reads the
 * studio's branding, or code-level defaults when never configured.
 */
@Controller('v1/organizations/:orgSlug/branding')
export class OrgBrandingController {
  constructor(@Inject(ORG_BRANDING_SERVICE) private readonly branding: OrgBrandingService) {}

  @Get()
  @RequireCapability('work.read')
  async get(@Ctx() context: TenantContext): Promise<OrgBrandingView> {
    return this.branding.get(context);
  }
}

/**
 * ADM / org identity (Administration, module 18, x327). The module that wires the two controllers and
 * their shared service. Registered in `app.module.ts` directly, so this slice touches no file another
 * admin slice in the same pass appends to. It reuses `org.manage` (set) and `work.read` (read), so it
 * adds nothing to the capability files.
 */
@Module({})
export class OrgBrandingModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: ORG_BRANDING_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new OrgBrandingService(database, new OrgBrandingRepository()),
    };

    return {
      module: OrgBrandingModule,
      providers: [service],
      controllers: [AdminOrgBrandingController, OrgBrandingController],
    };
  }
}
