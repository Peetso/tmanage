import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import {
  PORTAL_CHAT_SERVICE,
  PortalChatController,
  PortalChatService,
} from '../portal/portal-chat.controller.js';
import { ConversationsRepository } from './conversations.repository.js';
import { DirectConversationsRepository } from './direct-conversations.repository.js';
import { GROUP_INVITES_SERVICE, GroupInvitesController } from './group-invites.controller.js';
import { GroupInvitesService } from './group-invites.service.js';
import { GROUP_SETTINGS_SERVICE, GroupSettingsController } from './group-settings.controller.js';
import { GroupSettingsRepository } from './group-settings.repository.js';
import { GroupSettingsService } from './group-settings.service.js';

/**
 * R7 slice 3 wiring: group settings, invite links and the portal chat tab's list.
 *
 * File-disjoint from `ConversationsModule` (imported by it in one line) so this slice edits none of
 * the aggregate's files. Repositories are stateless and constructed here, the choice every sibling
 * conversation module documents. The portal list's controller lives in `modules/portal/` (its door)
 * and is registered here so the portal gains no module of its own for one route.
 */
@Module({})
export class ConversationGroupModule {
  static register(): DynamicModule {
    const settings: Provider = {
      provide: GROUP_SETTINGS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (database: TenantDatabase, audit: AuditService, outbox: OutboxEventsRepository) =>
        new GroupSettingsService(
          database,
          new GroupSettingsRepository(),
          new ConversationsRepository(),
          new DirectConversationsRepository(),
          new FileAssetsRepository(),
          audit,
          outbox,
        ),
    };
    const invites: Provider = {
      provide: GROUP_INVITES_SERVICE,
      inject: [GROUP_SETTINGS_SERVICE],
      useFactory: (groups: GroupSettingsService) => new GroupInvitesService(groups),
    };
    const portal: Provider = {
      provide: PORTAL_CHAT_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new PortalChatService(database),
    };
    return {
      module: ConversationGroupModule,
      providers: [settings, invites, portal],
      controllers: [GroupSettingsController, GroupInvitesController, PortalChatController],
    };
  }
}
