import { Controller, Get, Inject, Module, Param } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { IntegrationConnectionStatus } from '../../common/database/schema.js';
import { IntegrationCatalogService } from './catalog.service.js';
import { IntegrationConnectionsRepository } from './directory.repository.js';
import {
  ConnectionHealthService,
  type ConnectionHealthIssue,
} from './connection-health.service.js';

/**
 * Automations connection health (module 17, x220). Two read-only endpoints, both behind `org.manage`:
 * the health verdict for one recorded connection, and a roll-up over all of the acting tenant's
 * connections. No new table (the verdict is computed over the `integration_connections` x165 rows),
 * no `capabilities.ts` edit (`org.manage` reused).
 *
 * ## The Known-trap: read/compute only, no egress
 *
 * A "health check" invites an outbound ping to the third party. This deliberately does **not** ping:
 * a live probe of Slack/GitHub/… is external and paid (Needs-Peter). Every verdict is derived only
 * from data already in hand — the catalog (code), the connection's status, and its non-secret config
 * bag — so the checker makes no network request of any kind. The verdict also carries no config
 * *value*, only the names of missing required keys, so no stored setting leaks through it.
 *
 * ## Two authorization layers, and resolve-before-authorize
 *
 * `CapabilityGuard` asks the coarse role-ceiling question (`org.manage`). This controller adds the
 * authoritative org-scoped `authorize()` (`25-AUTH` §3, deny-by-default) a guard cannot — a suspended
 * membership or a client principal fails it. For the single-connection route the connection is
 * resolved **tenant-scoped first**: a cross-tenant `:id` is a 404 (it is not in this tenant) before
 * the org decision, exactly as the sibling by-id reads do.
 */

/**
 * The health verdict for one connection. Paired Exact with the web consumer. Deliberately carries no
 * config value: `missingConfigKeys` are code-defined key *names* absent by definition, and the stored
 * settings bag is never projected here.
 */
export interface ConnectionHealthView {
  readonly connectionId: string;
  readonly appId: string;
  readonly label: string;
  readonly status: IntegrationConnectionStatus;
  readonly healthy: boolean;
  readonly issues: readonly ConnectionHealthIssue[];
  readonly missingConfigKeys: readonly string[];
}

@Controller('v1/organizations/:orgSlug/automations/connections')
export class ConnectionHealthController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(IntegrationConnectionsRepository)
    private readonly connections: IntegrationConnectionsRepository,
    @Inject(ConnectionHealthService) private readonly health: ConnectionHealthService,
  ) {}

  /**
   * Roll up the health of every connection the acting tenant has recorded. `org.manage`, org-scoped
   * (a denial is a 403). The list read is tenant-scoped in the repository; a belt-and-braces tenant
   * filter runs before the map (Known-trap: scope before use).
   */
  @Get('health')
  @RequireCapability('org.manage')
  async report(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly connections: readonly ConnectionHealthView[] }> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'connection_health_report_denied',
      );
    }

    const rows = await this.database.read(context, (runner) =>
      this.connections.list(runner, context),
    );
    const connections = rows
      .filter((row) => row.organizationId === context.organizationId)
      .map((row) => this.health.evaluate(row));
    return { connections };
  }

  /**
   * The health verdict for one connection. The connection is resolved tenant-scoped **first**: a
   * cross-tenant or unknown `:id` is a 404 before the org-scoped `org.manage` decision (403).
   */
  @Get(':id/health')
  @RequireCapability('org.manage')
  async connectionHealth(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<ConnectionHealthView> {
    // Resolve-before-authorize: tenant-scoped fetch first, so a cross-tenant id is a 404, not a 403.
    const row = await this.database.read(context, (runner) =>
      this.connections.findById(runner, context, id),
    );
    if (row === null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'connection_not_found');
    }

    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'connection_health_denied',
      );
    }

    return this.health.evaluate(row);
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
 * The connection-health wiring — a self-contained module registered from `app.module.ts`,
 * file-disjoint from the other Automations slices. The catalog service, the health service (which
 * reads the catalog) and the read-only connections repository are stateless, constructed here.
 */
@Module({})
export class ConnectionHealthModule {
  static register(): DynamicModule {
    return {
      module: ConnectionHealthModule,
      providers: [
        { provide: IntegrationCatalogService, useFactory: () => new IntegrationCatalogService() },
        {
          provide: IntegrationConnectionsRepository,
          useFactory: () => new IntegrationConnectionsRepository(),
        },
        {
          provide: ConnectionHealthService,
          useFactory: (catalog: IntegrationCatalogService) => new ConnectionHealthService(catalog),
          inject: [IntegrationCatalogService],
        },
      ],
      controllers: [ConnectionHealthController],
    };
  }
}
