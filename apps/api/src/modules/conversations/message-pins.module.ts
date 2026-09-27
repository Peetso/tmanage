import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { MESSAGE_PINS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { MessagePinsRepository } from './message-pins.repository.js';
import { MessagePinsService } from './message-pins.service.js';
import { MessagePinsController } from './message-pins.controller.js';

/**
 * x247's wiring — a small aggregate of its own beside `ConversationsModule`, so the shared chat
 * module stays untouched.
 *
 * It owns its own read-only `ConversationsRepository` handle to resolve the conversation and the
 * message before it authorizes, exactly as `ConversationsModule`/`CalendarModule` construct their
 * own stateless repositories rather than importing the module that provides them: a repository is
 * a stateless collection of queries with no injected dependencies, so a second instance costs
 * nothing and reads honestly.
 *
 * The service is not exported: no client role holds a conversation capability, so there is no
 * client-facing pin surface, and there is no other internal caller of it.
 */
@Module({})
export class MessagePinsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: MESSAGE_PINS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new MessagePinsService(database, new MessagePinsRepository(), new ConversationsRepository()),
    };

    return {
      module: MessagePinsModule,
      providers: [service],
      controllers: [MessagePinsController],
    };
  }
}
