import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { createFieldCipher, loadFieldCipherKeyring } from '@tmanage/domain/field-cipher';
import type { Mailer } from '@tmanage/mail';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MAILER, TENANT_DATABASE } from '../../common/http/tokens.js';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import { PUBLIC_ABUSE_ASSESS } from '../public-abuse/public-abuse.guard.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import {
  PlatformSecurityReportsController,
  PublicSecurityReportsController,
  SECURITY_REPORTS_SERVICE,
} from './security-reports.controller.js';
import { SecurityReportsRepository } from './security-reports.repository.js';
import { SecurityReportsService } from './security-reports.service.js';

/**
 * 56-17 wiring. The service is stateless, so the public door and the platform area each build
 * their own: `SecurityReportsModule` beside the other public doors in `AppModule` (after
 * `RateLimitsModule`, whose global `PUBLIC_ABUSE_ASSESS` it takes when present), and
 * `PlatformSecurityReportsModule` in `PLATFORM_AREA_MODULES`, so the triage routes exist only
 * where the Platform admin does. The global `MAILER` is optional (absent: no acknowledgement).
 */
function serviceProvider(): Provider {
  return {
    provide: SECURITY_REPORTS_SERVICE,
    inject: [
      TENANT_DATABASE,
      { token: MAILER, optional: true },
      { token: PUBLIC_ABUSE_ASSESS, optional: true },
    ],
    useFactory: (
      database: TenantDatabase,
      mailer: Mailer | null | undefined,
      assess: AssessPublicWrite | undefined,
    ) =>
      new SecurityReportsService(
        new SecurityReportsRepository(database),
        createFieldCipher(loadFieldCipherKeyring(process.env)),
        mailer ?? null,
        assess ?? null,
      ),
  };
}

@Module({})
export class SecurityReportsModule {
  static register(): DynamicModule {
    return {
      module: SecurityReportsModule,
      providers: [serviceProvider()],
      controllers: [PublicSecurityReportsController],
    };
  }
}

@Module({})
export class PlatformSecurityReportsModule {
  static register(): DynamicModule {
    return {
      module: PlatformSecurityReportsModule,
      imports: [platformAdminCore()],
      providers: [serviceProvider()],
      controllers: [PlatformSecurityReportsController],
    };
  }
}
