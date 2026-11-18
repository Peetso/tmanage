import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import { ReferralsController } from './referrals.controller.js';
import { PlatformReferralsController } from './referrals-platform.controller.js';

/**
 * 57-08 REFERRAL — the owner's invite-link routes. Its own module so it adds nothing to billing;
 * the controller builds its service itself.
 */
@Module({})
export class ReferralsModule {
  static register(): DynamicModule {
    return { module: ReferralsModule, controllers: [ReferralsController] };
  }
}

/** 57-08 REFERRAL — the Platform admin partner list, a platform area module. */
@Module({})
export class PlatformReferralsModule {
  static register(): DynamicModule {
    return {
      module: PlatformReferralsModule,
      imports: [platformAdminCore()],
      controllers: [PlatformReferralsController],
    };
  }
}
