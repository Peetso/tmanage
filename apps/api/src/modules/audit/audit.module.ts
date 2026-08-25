import { Global, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_EVENTS_REPOSITORY,
  AUDIT_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AuditEventsRepository } from './audit-events.repository.js';
import { AuditService } from './audit.service.js';

/**
 * AUD-001's wiring.
 *
 * **Global**, which is a deliberate exception rather than convenience. Two unrelated
 * consumers need `AUDIT_SERVICE` from injectors this module does not own: `CapabilityGuard`,
 * registered as an `APP_GUARD` in `AppModule` and therefore resolved from the root injector,
 * and `ProjectsModule`, which wires the first command that writes an event. The alternative —
 * `AuditModule.register()` in each importer — would build a *second* service instance per
 * importer, because Nest treats two dynamic-module objects as two modules. Two audit services
 * would work and would be a trap: a future singleton concern (a batch, a counter, a sampler)
 * would silently exist twice.
 *
 * Audit is cross-cutting in the same sense the tenant guard is, so one instance for the whole
 * application is the correct shape as well as the convenient one.
 *
 * No controller. The audit **viewer** is ADMIN-002, and an HTTP surface for it now would be a
 * route whose scope narrowing this table cannot yet support — see `AuditService.view`.
 */
@Global()
@Module({})
export class AuditModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: AUDIT_EVENTS_REPOSITORY,
      useFactory: () => new AuditEventsRepository(),
    };
    const service: Provider = {
      provide: AUDIT_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_EVENTS_REPOSITORY],
      useFactory: (database: TenantDatabase, events: AuditEventsRepository) =>
        new AuditService(database, events),
    };

    return {
      module: AuditModule,
      global: true,
      providers: [repository, service],
      exports: [service, repository],
    };
  }
}
