import { Logger, Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { MAILER, TENANT_DATABASE } from '../../common/http/tokens.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import { NotificationsRepository } from '../inbox/notifications.repository.js';
import { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { platformAdminCore } from '../platform-admin/platform-admin-core.module.js';
import {
  PlatformSupportThreadsController,
  SUPPORT_SERVICE,
  SupportTargetsController,
  SupportThreadsController,
} from './support.controller.js';
import { SupportRepository } from './support.repository.js';
import { SupportService } from './support.service.js';

function webPublicUrl(): string {
  const value = process.env['WEB_PUBLIC_URL'];
  return value === undefined || value.trim() === '' ? 'http://localhost:3000' : value.trim();
}

function supportServiceProvider(): Provider {
  const logger = new Logger('SupportService');
  return {
    provide: SUPPORT_SERVICE,
    inject: [TENANT_DATABASE, { token: MAILER, optional: true }],
    useFactory: (database: TenantDatabase, mailer: Mailer | null | undefined) =>
      new SupportService({
        database,
        repository: new SupportRepository(),
        files: new FileAssetsRepository(),
        notifications: new NotificationsRepository(),
        outbox: new OutboxEventsRepository(),
        mailer: mailer ?? null,
        webPublicUrl: webPublicUrl(),
        onMailError: (error) =>
          logger.warn(
            `support reply e-mail not sent: ${error instanceof Error ? error.message : 'error'}`,
          ),
      }),
  };
}

/** 55-17 — the member side: `/v1/organizations/:orgSlug/support/threads…` (AppModule imports it). */
@Module({})
export class SupportModule {
  static register(): DynamicModule {
    return {
      module: SupportModule,
      providers: [supportServiceProvider()],
      controllers: [SupportThreadsController, SupportTargetsController],
    };
  }
}

/**
 * 55-17 — the platform team's side: `/v1/platform/support/threads…`, a platform area module
 * (listed in `platform-admin.areas.ts`, so it only exists while platform admin is on).
 */
@Module({})
export class PlatformSupportThreadsModule {
  static register(): DynamicModule {
    return {
      module: PlatformSupportThreadsModule,
      imports: [platformAdminCore()],
      providers: [supportServiceProvider()],
      controllers: [PlatformSupportThreadsController],
    };
  }
}
