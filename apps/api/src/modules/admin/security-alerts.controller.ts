import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Optional,
  Put,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AdminSecurityAlertsRepository } from './security-alerts.repository.js';
import { AdminSecurityAlertsService } from './security-alerts.service.js';
import type { SecurityAlertsView } from './security-alerts.service.js';

/** The PUT body — both fields arrive as `unknown` and are validated in the service. */
interface PutAlertBody {
  readonly eventTypeKey?: unknown;
  readonly enabled?: unknown;
}

/** The DELETE body — the key arrives as `unknown` and is validated in the service. */
interface DeleteAlertBody {
  readonly eventTypeKey?: unknown;
}

/**
 * Admin security-event alert configuration (Administration, security monitoring, x329) — three routes
 * behind `org.security.manage`: read the tenant's alert config with a read-only preview of recent
 * matching `audit_events`, toggle an alert on/off for one event-type key, and remove a key's config.
 * The config is stored and matched read-only; nothing is dispatched (no email/SMS — Needs-Peter).
 *
 * ## The capability guard, the real authorize, and the Known trap
 *
 * `@RequireCapability('org.security.manage')` is the coarse gate `CapabilityGuard` reads before any
 * handler runs. The service *also* runs the real `authorize` for the same capability — and on the
 * write paths it resolves the organization tenant-scoped **before** it authorizes or writes, so a
 * cross-tenant context is a 404 (no write), before the 403, before the 400 for an off-allowlist key.
 */
@Controller('v1/organizations/:orgSlug/admin/security-alerts')
export class AdminSecurityAlertsController {
  private readonly service: AdminSecurityAlertsService;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Optional() repository: AdminSecurityAlertsRepository = new AdminSecurityAlertsRepository(),
  ) {
    this.service = new AdminSecurityAlertsService(database, repository);
  }

  /** Read the allowlist, the tenant's config, and the recent audit matches for the enabled keys (200). */
  @Get()
  @RequireCapability('org.security.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SecurityAlertsView> {
    return this.service.list(context, principal);
  }

  /** Turn an alert on or off for one event-type key (200 — the config after the write). Idempotent. */
  @Put()
  @RequireCapability('org.security.manage')
  async configure(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PutAlertBody,
  ): Promise<SecurityAlertsView> {
    await this.service.configure(context, principal, {
      eventTypeKey: body?.eventTypeKey,
      enabled: body?.enabled,
    });
    return this.service.list(context, principal);
  }

  /** Remove an event-type key's config (204). Idempotent: removing an absent key is still 204. */
  @Delete()
  @RequireCapability('org.security.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: DeleteAlertBody,
  ): Promise<void> {
    await this.service.remove(context, principal, { eventTypeKey: body?.eventTypeKey });
  }
}

/**
 * x329's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * so the Administration slices stay file-disjoint. The repository is a stateless collection of the
 * tenant-scoped reads and writes, constructed here; the controller injects it and the `@Global`
 * `TENANT_DATABASE`.
 */
@Module({})
export class AdminSecurityAlertsModule {
  static register(): DynamicModule {
    return {
      module: AdminSecurityAlertsModule,
      providers: [
        {
          provide: AdminSecurityAlertsRepository,
          useFactory: () => new AdminSecurityAlertsRepository(),
        },
      ],
      controllers: [AdminSecurityAlertsController],
    };
  }
}
