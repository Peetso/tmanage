import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../../common/http/tokens.js';
import type { AuditService } from '../../audit/audit.service.js';
import { PLATFORM_AUDIT_SERVICE, platformAdminCore } from '../platform-admin-core.module.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import { PlatformMemberPermissionsController } from './member-permissions.controller.js';
import {
  PLATFORM_PERMISSIONS_SERVICE,
  PlatformOrgRolesController,
} from './org-roles.controller.js';
import { PlatformPermissionsService } from './permissions.service.js';

/** Platform admin · Permission editors (D7/D8; listed in `platform-admin.areas.ts`). */
@Module({})
export class PlatformPermissionsModule {
  static register(): DynamicModule {
    return {
      module: PlatformPermissionsModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_PERMISSIONS_SERVICE,
          inject: [
            TENANT_DATABASE,
            PLATFORM_AUDIT_SERVICE,
            { token: AUDIT_SERVICE, optional: true },
          ],
          useFactory: (
            database: TenantDatabase,
            platformAudit: PlatformAuditService,
            audit: AuditService | undefined,
          ) => new PlatformPermissionsService(database, platformAudit, audit),
        },
      ],
      controllers: [PlatformOrgRolesController, PlatformMemberPermissionsController],
    };
  }
}
