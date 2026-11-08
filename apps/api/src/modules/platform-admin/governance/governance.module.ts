import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { MAILER, TENANT_DATABASE } from '../../../common/http/tokens.js';
import { platformAdminCore } from '../platform-admin-core.module.js';
import {
  PLATFORM_GOVERNANCE_SERVICE,
  PlatformGovernanceController,
} from './governance.controller.js';
import { GovernanceRepository } from './governance.repository.js';
import { PlatformGovernanceService } from './governance.service.js';

/** Platform admin · Governance (56-21): two-person approvals and owner notices. */
@Module({})
export class PlatformGovernanceModule {
  static register(): DynamicModule {
    return {
      module: PlatformGovernanceModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_GOVERNANCE_SERVICE,
          inject: [TENANT_DATABASE, { token: MAILER, optional: true }],
          useFactory: (database: TenantDatabase, mailer: Mailer | null | undefined) =>
            new PlatformGovernanceService(new GovernanceRepository(database), mailer ?? null),
        },
      ],
      controllers: [PlatformGovernanceController],
    };
  }
}
