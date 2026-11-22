import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import {
  OrganizationSecurityEventsController,
  PlatformAlertRulesController,
  PlatformSecuritySignalsController,
} from './security-signals.controller.js';
import { SecuritySignalsRepository } from './security-signals.repository.js';
import { SECURITY_SIGNALS_SERVICE, SecuritySignalsService } from './security-signals.service.js';
import {
  SOURCE_FINDINGS_JOB,
  SourceFindingsJob,
  sourceFindingsJobEnabled,
} from './source-findings-job.js';
import { SourceFindingsRepository } from './source-findings.repository.js';

/**
 * 56-23 wiring. The service is stateless, so the organization route and the platform area each
 * build their own: `SecuritySignalsModule` in `AppModule` (the org `admin/security/events` read)
 * and `PlatformSecuritySignalsModule` in `PLATFORM_AREA_MODULES`, so the alert rules and the
 * platform signal list exist only where the Platform admin does.
 */
function serviceProvider(): Provider {
  return {
    provide: SECURITY_SIGNALS_SERVICE,
    inject: [TENANT_DATABASE],
    useFactory: (database: TenantDatabase) =>
      new SecuritySignalsService(new SecuritySignalsRepository(database)),
  };
}

/**
 * SEC-ALERTS. The sign-in door's rules over `authentication_events`, evaluated where the read
 * already is (`source-findings.ts`); in `SecuritySignalsModule` only, so one copy runs per process.
 */
function sourceFindingsJobProvider(): Provider {
  return {
    provide: SOURCE_FINDINGS_JOB,
    inject: [TENANT_DATABASE],
    useFactory: (database: TenantDatabase) =>
      new SourceFindingsJob(new SourceFindingsRepository(database), sourceFindingsJobEnabled()),
  };
}

@Module({})
export class SecuritySignalsModule {
  static register(): DynamicModule {
    return {
      module: SecuritySignalsModule,
      providers: [serviceProvider(), sourceFindingsJobProvider()],
      controllers: [OrganizationSecurityEventsController],
    };
  }
}

@Module({})
export class PlatformSecuritySignalsModule {
  static register(): DynamicModule {
    return {
      module: PlatformSecuritySignalsModule,
      imports: [platformAdminCore()],
      providers: [serviceProvider()],
      controllers: [PlatformAlertRulesController, PlatformSecuritySignalsController],
    };
  }
}
