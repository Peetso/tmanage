import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../identity/session.service.js';
import { CONTACT_MAX_PER_WINDOW, CONTACT_WINDOW_MS } from '../public-site/contact.module.js';
import { ProvisioningService } from '../tenancy/provisioning.service.js';
import { FirstOwnerController } from './first-owner.controller.js';
import { FirstOwnerService } from './first-owner.service.js';
import {
  FIRST_OWNER_ADMISSION,
  FIRST_OWNER_SERVICE,
  FIRST_OWNER_SESSIONS,
} from './first-owner.tokens.js';

/**
 * First-owner setup: the one way a fresh production install gets its first organisation owner,
 * since there is no public sign-up.
 *
 * `app.module.ts` registers this module only when `SETUP_TOKEN` is set. With no token the routes
 * are never added to the router at all, so they 404 like any unknown path — the same reasoning as
 * the development sign-in route in `identity.module.ts`: a route that was never registered has no
 * code path a misconfigured guard could open. The service additionally refuses once any
 * organisation exists, so a token left set after setup does not reopen it.
 *
 * Every provider carries an explicit token (ADR-0003). `TENANT_DATABASE`, `AUDIT_SERVICE` and
 * `API_CONFIG` are global.
 */
@Module({})
export class FirstOwnerModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: FIRST_OWNER_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig) =>
        new FirstOwnerService(
          database,
          new ProvisioningService(database, audit),
          config.setupToken ?? null,
        ),
    };

    // Constructed exactly as in `identity.module.ts`. SessionService holds no state of its own —
    // every session lives in the database — so a second instance here is safe and keeps this
    // module from depending on IdentityModule's exports.
    const sessions: Provider = {
      provide: FIRST_OWNER_SESSIONS,
      inject: [TENANT_DATABASE, API_CONFIG],
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new SessionService(database, config),
    };

    // Rate-limited like the contact form: same window, same ceiling, same RATE_LIMIT_CONTACT_*
    // overrides. In process, so a restart forgets the windows.
    const admission: Provider = {
      provide: FIRST_OWNER_ADMISSION,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) =>
        createFixedWindowLimiter({
          windowMs: config.contactWindowMs ?? CONTACT_WINDOW_MS,
          max: config.contactMaxPerWindow ?? CONTACT_MAX_PER_WINDOW,
        }),
    };

    return {
      module: FirstOwnerModule,
      providers: [service, sessions, admission],
      controllers: [FirstOwnerController],
    };
  }
}
