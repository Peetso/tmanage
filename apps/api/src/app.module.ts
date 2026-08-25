import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ApiConfigModule } from './common/http/api-config.js';
import type { ApiConfig } from './common/http/api-config.js';
import { CorrelationInterceptor } from './common/http/correlation.interceptor.js';
import { HttpExceptionFilter } from './common/http/http-exception.filter.js';
import { SessionAuthGuard } from './common/http/guards/session-auth.guard.js';
import { CsrfGuard } from './common/http/guards/csrf.guard.js';
import { TenantContextGuard } from './common/http/guards/tenant-context.guard.js';
import { CapabilityGuard } from './common/http/guards/capability.guard.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { AuditModule } from './modules/audit/audit.module.js';

/**
 * The request pipeline, assembled in the order `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`
 * §3 specifies.
 *
 * Nest applies global guards in registration order, so this array **is** the policy sequence.
 * It is worth reading as one:
 *
 * | # | Guard                | §3 step | Refuses                                          |
 * | - | -------------------- | ------- | ------------------------------------------------ |
 * | 1 | `SessionAuthGuard`   | 1       | no/forged/revoked/expired session → 401          |
 * | 2 | `CsrfGuard`          | 04 §3   | unsafe method without a session-bound token → 403 |
 * | 3 | `TenantContextGuard` | 2–4     | no active membership for the named org → 404     |
 * | 4 | `CapabilityGuard`    | 5       | capability outside the role ceiling → 403        |
 *
 * Two properties of this ordering are load-bearing rather than aesthetic:
 *
 * - CSRF must come **after** authentication, because the token is bound to a session id and
 *   there is nothing to bind against until step 1 has run.
 * - The capability check must come **after** the tenant context, because a capability is
 *   meaningless without a principal, and a principal only exists once a membership has proved
 *   which organization this request is in.
 *
 * They are registered globally rather than per-controller so the default for a new route is
 * the whole sequence. Opting out is an explicit `@Public()` or `@NoTenant()` — a visible line
 * in a diff — rather than the silent consequence of forgetting an annotation.
 */

export interface AppModuleOptions {
  /**
   * The database wiring, already built — `DatabaseModule.forUrl()` in production,
   * `DatabaseModule.forPool()` in the database suite.
   *
   * Passed in rather than constructed here, and the reason is ADR-0001 layer 4 rather than
   * taste: the lint boundary permits a driver handle only under `src/common/database/`, and an
   * earlier draft that took a `Pool` on this interface was rejected by it. The rule was right.
   * A composition root that cannot name a connection pool is one that cannot accidentally hand
   * one to a controller.
   */
  readonly database: DynamicModule;
  readonly config: ApiConfig;
}

@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ApiConfigModule.forConfig(options.config),
        options.database,
        // Before the modules whose commands write audit events, and before the global
        // `CapabilityGuard` below resolves `AUDIT_SERVICE` from this injector.
        AuditModule.register(),
        TenancyModule.register(),
        options.config.allowDevelopmentSignIn
          ? IdentityModule.registerWithDevelopmentSignIn()
          : IdentityModule.register(),
        ProjectsModule.register(),
      ],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
        { provide: APP_GUARD, useClass: SessionAuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: TenantContextGuard },
        { provide: APP_GUARD, useClass: CapabilityGuard },
      ],
    };
  }
}
