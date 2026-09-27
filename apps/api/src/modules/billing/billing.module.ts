import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  BILLING_PROFILE_REPOSITORY,
  BILLING_TAX_DETAILS_REPOSITORY,
  BILLING_TAX_DETAILS_SERVICE,
  PLAN_PREVIEW_SERVICE,
  SUBSCRIPTION_REPOSITORY,
  SUBSCRIPTION_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { SubscriptionRepository } from './subscription.repository.js';
import { SubscriptionService } from './subscription.service.js';
import { SubscriptionController } from './subscription.controller.js';
import { PlanPreviewService } from './plan-preview.service.js';
import { PlanPreviewController } from './plan-preview.controller.js';
import { BillingProfileRepository } from './profile.repository.js';
import { BillingProfileController } from './profile.controller.js';
import { BillingTaxDetailsRepository } from './tax-details.repository.js';
import { BillingTaxDetailsService } from './tax-details.service.js';
import { BillingTaxDetailsController } from './tax-details.controller.js';

/**
 * Billing / module 19 (x177). The subscription module — an organization's current plan (view, and
 * request a plan change).
 *
 * Same shape as `OrgObjectivesModule` (x136): a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. Org-scoped (no project in the
 * path), so it needs no `ProjectsRepository` to resolve one, and it depends only on the global tenant
 * database — it couples to no other feature module's wiring.
 *
 * Billing (module 19, x180) — also carries the billing-settings wiring: one stateless profile
 * repository under its token and one controller that injects it alongside the tenant database. The
 * controller authorizes (`org.manage`, deny-by-default) and validates, and the repository owns the
 * single org-scoped read/upsert — the same shape the work-forms slice takes.
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
    // Billing / module 19 (x198). The plan-change preview reuses the subscriptions repository for the
    // tenant-scoped current-plan read; it writes nothing and charges nothing (estimate only).
    const planPreview: Provider = {
      provide: PLAN_PREVIEW_SERVICE,
      inject: [TENANT_DATABASE, SUBSCRIPTION_REPOSITORY],
      useFactory: (database: TenantDatabase, subscriptions: SubscriptionRepository) =>
        new PlanPreviewService(database, subscriptions),
    };
    const profileRepository: Provider = {
      provide: BILLING_PROFILE_REPOSITORY,
      useFactory: () => new BillingProfileRepository(),
    };
    // Billing / module 19 (x283). Tax / legal-entity details — a stateless repository under its token
    // and a service that takes the tenant database and the repository, the same shape as above.
    const taxDetailsRepository: Provider = {
      provide: BILLING_TAX_DETAILS_REPOSITORY,
      useFactory: () => new BillingTaxDetailsRepository(),
    };
    const taxDetailsService: Provider = {
      provide: BILLING_TAX_DETAILS_SERVICE,
      inject: [TENANT_DATABASE, BILLING_TAX_DETAILS_REPOSITORY],
      useFactory: (database: TenantDatabase, repository: BillingTaxDetailsRepository) =>
        new BillingTaxDetailsService(database, repository),
    };

    return {
      module: BillingModule,
      providers: [
        repository,
        service,
        planPreview,
        profileRepository,
        taxDetailsRepository,
        taxDetailsService,
      ],
      exports: [service, planPreview],
      controllers: [
        SubscriptionController,
        PlanPreviewController,
        BillingProfileController,
        BillingTaxDetailsController,
      ],
    };
  }
}
