import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  SUBSCRIPTION_REPOSITORY,
  SUBSCRIPTION_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SubscriptionService } from './subscription.service.js';
import { SubscriptionController } from './subscription.controller.js';

/**
 * Billing / module 19 (x177). The subscription module — an organization's current plan (view, and
 * request a plan change).
 *
 * Same shape as `OrgObjectivesModule` (x136): a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. Org-scoped (no project in the
 * path), so it needs no `ProjectsRepository` to resolve one, and it depends only on the global tenant
 * database — it couples to no other feature module's wiring.
 */
@Module({})
export class BillingModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: SUBSCRIPTION_REPOSITORY,
      useFactory: () => new SubscriptionRepository(),
    };
    const service: Provider = {
      provide: SUBSCRIPTION_SERVICE,
      inject: [TENANT_DATABASE, SUBSCRIPTION_REPOSITORY],
      useFactory: (database: TenantDatabase, subscriptions: SubscriptionRepository) =>
        new SubscriptionService(database, subscriptions),
    };

    return {
      module: BillingModule,
      providers: [repository, service],
      exports: [service],
      controllers: [SubscriptionController],
    };
  }
}
