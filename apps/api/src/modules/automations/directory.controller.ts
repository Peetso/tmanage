import { Body, Controller, Get, HttpCode, Inject, Module, Param, Post } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  INTEGRATION_CONNECTION_STATUSES,
  type IntegrationConnectionConfig,
  type IntegrationConnectionRow,
  type IntegrationConnectionStatus,
} from '../../common/database/schema.js';
import { IntegrationCatalogService } from './catalog.service.js';
import { IntegrationConnectionsRepository } from './directory.repository.js';

/**
 * Automations app directory (module 17, x165). Two endpoints, both behind `org.manage`: read the app
 * catalog merged with the organization's connections, and record a new connection against a catalog
 * app.
 *
 * ## Two authorization layers, and the write boundary
 *
 * `CapabilityGuard` on each route asks the coarse `org.manage` question — does this role's ceiling
 * include the capability at all. This controller adds the authoritative application decision
 * (`25-AUTH` §3 step 2, deny-by-default) the guard cannot: an org-scoped `authorize()`
 * (`projectId: null`) that a suspended membership or a client principal fails, exactly as the sibling
 * org-scoped writes do. `org.manage` is internal-only (`capabilities.ts`), so a client principal is
 * refused here as well as by the guard — belt and braces.
 *
 * ## The Known-trap order (create)
 *
 * A create names a catalog app by id in the path. That id is validated against the **code-defined
 * catalog first**, so an unknown / off-catalog `appId` is a 404 with no write, before any body
 * validation. The body is then validated — a bad label, an over-large config, or a **secret-shaped
 * config key** is a 400 with no write — and only then is the row inserted. No credentials or tokens
 * are ever stored: `config_json` is non-secret settings only (live secret exchange is Needs-Peter).
 * A connection row never echoes `organization_id`.
 */

/** The integration's own descriptive capabilities (not RBAC), plus the org's connections to it. */
export interface IntegrationAppView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly capabilities: readonly string[];
  readonly connections: readonly IntegrationConnectionView[];
}

/** What a caller is allowed to see of one connection. `organizationId` is deliberately absent. */
export interface IntegrationConnectionView {
  readonly id: string;
  readonly appId: string;
  readonly label: string;
  readonly status: IntegrationConnectionStatus;
  readonly config: IntegrationConnectionConfig;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toConnectionView(row: IntegrationConnectionRow): IntegrationConnectionView {
  return {
    id: row.id,
    appId: row.appId,
    label: row.label,
    status: row.status,
    config: row.configJson,
    createdAt: row.createdAt.toISOString(),
  };
}

interface CreateConnectionBody {
  readonly label?: unknown;
  readonly status?: unknown;
  readonly config?: unknown;
}

/** Bounds on the non-secret config bag. Small on purpose: this is settings, not a document. */
const MAX_CONFIG_KEYS = 30;
const MAX_CONFIG_KEY_LENGTH = 64;
const MAX_CONFIG_VALUE_LENGTH = 2048;
const MAX_LABEL_LENGTH = 300;

/**
 * Keys that look like a credential. A config bag is settings only; a key matching this is rejected
 * with a 400 so a token can never be smuggled into a row this slice deliberately does not secure for
 * secrets (secret exchange is Needs-Peter). Substring, case-insensitive.
 */
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|api[_-]?key|apikey|credential|private[_-]?key|client[_-]?secret|access[_-]?key|refresh[_-]?token|bearer|passphrase)/i;

/** Validate the display label: a non-empty, bounded string. */
function validateLabel(raw: unknown): string {
  const label = typeof raw === 'string' ? raw.trim() : '';
  if (label === '' || label.length > MAX_LABEL_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      {
        field: 'label',
        message: `must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`,
      },
    ]);
  }
  return label;
}

/** Validate the status: absent defaults to `pending`; present must be one of the enum values. */
function validateStatus(raw: unknown): IntegrationConnectionStatus {
  if (raw === undefined) return 'pending';
  if (
    typeof raw !== 'string' ||
    !(INTEGRATION_CONNECTION_STATUSES as readonly string[]).includes(raw)
  ) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'status', message: `must be one of: ${INTEGRATION_CONNECTION_STATUSES.join(', ')}` },
    ]);
  }
  return raw as IntegrationConnectionStatus;
}

/**
 * Validate the config bag: absent defaults to `{}`; present must be a plain object of bounded scalar
 * values under bounded, non-secret keys. A secret-shaped key, an over-large bag, or a non-scalar value
 * is a 400 — no credential can be persisted here.
 */
function validateConfig(raw: unknown): IntegrationConnectionConfig {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'config', message: 'must be an object of non-secret settings' },
    ]);
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_CONFIG_KEYS) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'config', message: `must have at most ${MAX_CONFIG_KEYS} keys` },
    ]);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_CONFIG_KEY_LENGTH) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: `config.${key}`, message: `key must be 1..${MAX_CONFIG_KEY_LENGTH} characters` },
      ]);
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      // The write boundary: a credential-shaped key is refused so a token is never stored here.
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: `config.${key}`, message: 'secret-shaped config keys are not allowed' },
      ]);
    }
    if (typeof value === 'string') {
      if (value.length > MAX_CONFIG_VALUE_LENGTH) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          {
            field: `config.${key}`,
            message: `value must be at most ${MAX_CONFIG_VALUE_LENGTH} characters`,
          },
        ]);
      }
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: `config.${key}`, message: 'value must be a finite number' },
        ]);
      }
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: `config.${key}`, message: 'value must be a string, number, or boolean' },
      ]);
    }
  }
  return out;
}

@Controller('v1/organizations/:orgSlug/automations/apps')
export class IntegrationDirectoryController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(IntegrationCatalogService) private readonly catalog: IntegrationCatalogService,
    @Inject(IntegrationConnectionsRepository)
    private readonly connections: IntegrationConnectionsRepository,
  ) {}

  /**
   * The app directory: the static catalog, each app merged with the acting tenant's connections to it.
   * `org.manage`, relation-gated org-scoped (a denial is a 403 — the catalog is not an object to hide).
   */
  @Get()
  @RequireCapability('org.manage')
  async directory(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly apps: readonly IntegrationAppView[] }> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'integration_directory_denied',
      );
    }

    const rows = await this.database.read(context, (runner) =>
      this.connections.list(runner, context),
    );
    // Belt-and-braces tenant filter before grouping (Known-trap: scope before use).
    const byApp = new Map<string, IntegrationConnectionView[]>();
    for (const row of rows) {
      if (row.organizationId !== context.organizationId) continue;
      const list = byApp.get(row.appId) ?? [];
      list.push(toConnectionView(row));
      byApp.set(row.appId, list);
    }

    const apps = this.catalog.list().map<IntegrationAppView>((app) => ({
      id: app.id,
      name: app.name,
      category: app.category,
      capabilities: app.capabilities,
      connections: byApp.get(app.id) ?? [],
    }));
    return { apps };
  }

  /**
   * Record a connection against a catalog app.
   *
   * `appId` is validated against the code-defined catalog BEFORE anything else (Known-trap): an
   * off-catalog id is a 404 with no write. The body is validated next (bad label / over-large or
   * secret-shaped config → 400, no write), and only then is the row inserted. No credentials are
   * stored. The response is the created connection.
   */
  @Post(':appId/connections')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async connect(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('appId') appId: string,
    @Body() body: CreateConnectionBody,
  ): Promise<IntegrationConnectionView> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'integration_connect_denied',
      );
    }

    // Known-trap: validate the app against the catalog first. Off-catalog ⇒ 404, no write.
    if (typeof appId !== 'string' || this.catalog.findById(appId) === null) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'integration_app_not_found',
      );
    }

    const label = validateLabel(body?.label);
    const status = validateStatus(body?.status);
    const config = validateConfig(body?.config);

    const row = await this.database.transaction(context, (tx) =>
      this.connections.create(tx, context, {
        appId,
        label,
        status,
        config,
        createdBy: context.userId,
      }),
    );
    return toConnectionView(row);
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, audience). */
  private mayManageOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * The Automations directory's wiring — a self-contained module registered from `app.module.ts` (the
 * shared append point), file-disjoint from the other Automations slices. The catalog service and the
 * connections repository are stateless, constructed here; the controller injects them and the
 * `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class IntegrationDirectoryModule {
  static register(): DynamicModule {
    return {
      module: IntegrationDirectoryModule,
      providers: [
        { provide: IntegrationCatalogService, useFactory: () => new IntegrationCatalogService() },
        {
          provide: IntegrationConnectionsRepository,
          useFactory: () => new IntegrationConnectionsRepository(),
        },
      ],
      controllers: [IntegrationDirectoryController],
    };
  }
}
