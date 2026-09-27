import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { BILLING_PROFILE_REPOSITORY } from '../../common/http/tokens.js';
import { BillingProfileRepository } from './profile.repository.js';
import { BillingProfileController } from './profile.controller.js';

/**
 * Billing (module 19, x180) — the billing-settings wiring.
 *
 * One stateless repository under its token and one controller that injects it alongside the tenant
 * database. There is no service layer: the controller authorizes (`org.manage`, deny-by-default) and
 * validates, and the repository owns the single org-scoped read/upsert — the same shape the
 * work-forms slice takes. It depends only on the global tenant database, so it couples to no other
 * module and its position in `AppModule` is by subject, not by need.
 */
@Module({})
export class BillingModule {
  static register(): DynamicModule {
    const profileRepository: Provider = {
      provide: BILLING_PROFILE_REPOSITORY,
      useFactory: () => new BillingProfileRepository(),
    };

    return {
      module: BillingModule,
      providers: [profileRepository],
      controllers: [BillingProfileController],
    };
  }
}
