import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { ObjectStore } from '@tmanage/storage';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { OBJECT_STORE, TENANT_DATABASE } from '../../../common/http/tokens.js';
import { PLATFORM_AUDIT_SERVICE, platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_ALLOWLIST, PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import type { PlatformAuditService } from '../platform-audit.service.js';
import { SupportSessionsRepository } from '../support/support-sessions.repository.js';
import { PlatformAccessController } from './access.controller.js';
import { PlatformActionsController } from './actions.controller.js';
import { PLATFORM_ACTIVITY_SERVICE, PlatformActivityController } from './activity.controller.js';
import { ActivityRepository } from './activity.repository.js';
import { PlatformActivityService } from './activity.service.js';
import { ExportsRepository } from './exports.repository.js';
import { PlatformExportsController } from './exports.controller.js';
// ---- R13 slice 5 · 57-14 ---- Growth rollups (reads only).
import { PLATFORM_GROWTH_REPOSITORY, PlatformGrowthController } from './growth.controller.js';
import { GrowthRepository } from './growth.repository.js';
import { PlatformAdminActionsController } from './platform-actions.controller.js';
import { PlatformSupportSessionsListController } from './support-sessions-list.controller.js';

/**
 * Platform admin · Activity & access (listed in `platform-admin.areas.ts`; platform-admin v2 ·
 * PA-09 — C1–C6). The object store is the global `StorageModule`'s (optional: a deployment with
 * no driver lists exports and refuses downloads).
 */
@Module({})
export class PlatformActivityModule {
  static register(): DynamicModule {
    return {
      module: PlatformActivityModule,
      imports: [platformAdminCore()],
      providers: [
        {
          provide: PLATFORM_ACTIVITY_SERVICE,
          inject: [
            TENANT_DATABASE,
            PLATFORM_ADMIN_LOOKUP,
            PLATFORM_AUDIT_SERVICE,
            PLATFORM_ADMIN_ALLOWLIST,
            { token: OBJECT_STORE, optional: true },
          ],
          useFactory: (
            database: TenantDatabase,
            admins: PlatformAdminRepository,
            audit: PlatformAuditService,
            allowlist: readonly string[],
            objectStore: ObjectStore | undefined,
          ) =>
            new PlatformActivityService({
              admins,
              activity: new ActivityRepository(database),
              exports: new ExportsRepository(database),
              supportSessions: new SupportSessionsRepository(database),
              audit,
              allowlist,
              objectStore: objectStore ?? null,
            }),
        },
        {
          provide: PLATFORM_GROWTH_REPOSITORY,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) => new GrowthRepository(database),
        },
      ],
      controllers: [
        PlatformActivityController,
        PlatformActionsController,
        PlatformAccessController,
        PlatformAdminActionsController,
        PlatformSupportSessionsListController,
        PlatformExportsController,
        PlatformGrowthController,
      ],
    };
  }
}
