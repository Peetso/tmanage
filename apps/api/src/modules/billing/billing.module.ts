import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { ApiConfig } from '../../common/http/api-config.js';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  BILLING_PROFILE_REPOSITORY,
  BILLING_TAX_DETAILS_REPOSITORY,
  BILLING_TAX_DETAILS_SERVICE,
  PLAN_PREVIEW_SERVICE,
  SUBSCRIPTION_REPOSITORY,
  SUBSCRIPTION_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
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
import { PlanChangeRequestsRepository } from './plan-change-requests.repository.js';
import { PlanChangeRequestsService } from './plan-change-requests.service.js';
import {
  PLAN_CHANGE_REQUESTS_SERVICE,
  PlanChangeRequestsController,
} from './plan-change-requests.controller.js';
import { PlanUsageService } from './plan-usage.service.js';
import { StorageAllowanceService } from './storage-allowance.service.js';
import { PLAN_USAGE_SERVICE, PlanUsageController } from './plan-usage.controller.js';
import {
  PLAN_VERSIONS_SERVICE,
  PlatformPlanVersionsController,
  PublicPlanVersionsController,
  WorkspacePlanController,
} from './plan-versions.controller.js';
import { PlanVersionsRepository } from './plan-versions.repository.js';
import { PlanVersionsService } from './plan-versions.service.js';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import { PlatformAiBudgetSettings } from '../platform-admin/settings/ai-budget.js';
import { AiAllowanceService } from './ai-allowance.service.js';
import { AI_PACKS_SERVICE, AiCreditsController } from './ai-packs.controller.js';
import { AiPacksService } from './ai-packs.service.js';
import {
  AI_PACKS_PLATFORM_SERVICE,
  PlatformAiTestListController,
} from './ai-packs-platform.controller.js';
import { AiPacksPlatformService } from './ai-packs-platform.service.js';

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
      // 2026-10-31 live test: the save is audited — the global audit service, injected optionally.
      inject: [
        TENANT_DATABASE,
        BILLING_TAX_DETAILS_REPOSITORY,
        { token: AUDIT_SERVICE, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        repository: BillingTaxDetailsRepository,
        audit?: AuditService,
      ) => new BillingTaxDetailsService(database, repository, audit),
    };
    // Billing / module 19 (x284). Plan-change requests — a recorded intent to move plans. A stateless
    // repository folded into the service under a slice-private token (no `tokens.ts` edit), the same
    // shape the other billing wiring here takes. Reuses `org.manage`; adds nothing to the caps files.
    const planChangeRequests: Provider = {
      provide: PLAN_CHANGE_REQUESTS_SERVICE,
      // ADM-11 (CQ-08): the globally-exported audit service is injected optionally (the custom-roles
      // posture) so a submission and a cancellation each leave an audit row in the same transaction.
      inject: [TENANT_DATABASE, { token: AUDIT_SERVICE, optional: true }],
      useFactory: (database: TenantDatabase, audit?: AuditService) =>
        new PlanChangeRequestsService(database, new PlanChangeRequestsRepository(), audit),
    };
    // Figma F4 (Plan and usage). Read-only: plan limits from the catalog, usage counted from existing
    // tables. A slice-private token, no `tokens.ts` edit; the repositories are stateless.
    const planUsage: Provider = {
      provide: PLAN_USAGE_SERVICE,
      inject: [TENANT_DATABASE, API_CONFIG],
      // 57-13r: the storage meter is the temporary allowance, under the platform cap.
      useFactory: (database: TenantDatabase, config: ApiConfig) =>
        new PlanUsageService(
          database,
          new StorageAllowanceService(database, config.storageOrgBytesLimit),
        ),
    };
    // 57-02. The versioned plan ladder (`plan_versions`, global): the Platform admin's list and
    // publish routes and the workspace's own current-plan read. Off during the beta (PLAN_LADDER).
    const planVersions: Provider = {
      provide: PLAN_VERSIONS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new PlanVersionsService(database, new PlanVersionsRepository(database)),
    };

    // 62-07 (plan 62 §5). The AI credit allowance, the credit packs and the owner's pack request
    // (`ai-packs.controller.ts`), and the platform admin's test list and pack grants
    // (`ai-packs-platform.controller.ts`). The pool cap the allowance stops at is the env share
    // until the orchestrator (62-09) wires the 62-08 settings source; nothing here calls a model.
    const aiPacks: Provider = {
      provide: AI_PACKS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new AiPacksService({
          database,
          allowance: new AiAllowanceService({
            database,
            // 62-08: the platform admin's pool caps, else the env split.
            poolCapMicroUsd: new PlatformAiBudgetSettings().poolCapMicroUsd,
          }),
          audit,
        }),
    };
    const aiPacksPlatform: Provider = {
      provide: AI_PACKS_PLATFORM_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new AiPacksPlatformService({ database }),
    };

    return {
      module: BillingModule,
      // The platform-admin guard's lookup, for `PlatformPlanVersionsController`.
      imports: [platformAdminCore()],
      providers: [
        repository,
        service,
        planPreview,
        profileRepository,
        taxDetailsRepository,
        taxDetailsService,
        planChangeRequests,
        planUsage,
        planVersions,
        aiPacks,
        aiPacksPlatform,
      ],
      exports: [service, planPreview],
      controllers: [
        SubscriptionController,
        PlanPreviewController,
        BillingProfileController,
        BillingTaxDetailsController,
        PlanChangeRequestsController,
        PlanUsageController,
        PlatformPlanVersionsController,
        WorkspacePlanController,
        // PLANWEB: the pricing page's live figures (nothing while the beta is free).
        PublicPlanVersionsController,
        // 62-07: the workspace's AI credits and pack request; the platform's AI test list.
        AiCreditsController,
        PlatformAiTestListController,
      ],
    };
  }
}
