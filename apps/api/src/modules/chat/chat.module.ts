import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { CHAT_LIST_SERVICE, ChatListController } from './chat-list.controller.js';
import { ChatListRepository } from './chat-list.repository.js';
import { ChatListService } from './chat-list.service.js';

/** R7 slice 2 — the chat list module. Explicit token (ADR-0003); a stateless repository. */
@Module({})
export class ChatModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: CHAT_LIST_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ChatListService(database, new ChatListRepository()),
    };
    return { module: ChatModule, providers: [service], controllers: [ChatListController] };
  }
}
