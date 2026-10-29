import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { TENANT_DATABASE } from '../../../common/http/tokens.js';
import { PLATFORM_AUDIT_SERVICE, platformAdminCore } from '../platform-admin-core.module.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import { SUPPORT_SESSION_SERVICE, SupportSessionController } from './support-session.controller.js';
import {
  SupportSessionService,
  registerSupportSignOutListener,
} from './support-session.service.js';

/**
 * Platform admin · Support mode (platform-admin v2 · PA-05; listed in `platform-admin.areas.ts`).
 * Building the service also registers it as the sign-out listener the identity module calls.
 */
@Module({})
export class PlatformSupportModule {
  static register(): DynamicModule {
    return {
      module: PlatformSupportModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: SUPPORT_SESSION_SERVICE,
          inject: [TENANT_DATABASE, PLATFORM_AUDIT_SERVICE],
          useFactory: (database: TenantDatabase, audit: PlatformAuditService) => {
            const service = new SupportSessionService(database, audit);
            registerSupportSignOutListener({
              browserSessionEnded: async (userId, browserSessionId, correlationId) => {
                await service.endForBrowserSession(userId, browserSessionId, correlationId);
              },
            });
            return service;
          },
        },
      ],
      controllers: [SupportSessionController],
      exports: [SUPPORT_SESSION_SERVICE],
    };
  }
}
