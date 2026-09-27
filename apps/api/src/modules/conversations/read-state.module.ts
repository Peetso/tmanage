import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { CONVERSATION_READ_STATE_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationReadStateRepository } from './read-state.repository.js';
import { ConversationReadStateService } from './read-state.service.js';
import { ConversationReadStateController } from './read-state.controller.js';

/**
 * Conversation read-state wiring (module CHAT, x250).
 *
 * A module of its own — file-disjoint from `ConversationsModule` — so this slice edits no file
 * another chat slice appends to. `ConversationsRepository` and `ConversationReadStateRepository` are
 * constructed here rather than imported from `ConversationsModule`: a repository is a stateless
 * collection of queries with no injected dependencies, so a second instance costs nothing, the same
 * choice `ConversationsModule` itself documents for `ProjectsRepository`. The service depends only on
 * the global tenant database and those two repositories. Every provider carries an explicit token
 * (ADR-0003).
 */
@Module({})
export class ConversationReadStateModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: CONVERSATION_READ_STATE_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ConversationReadStateService(
          database,
          new ConversationsRepository(),
          new ConversationReadStateRepository(),
        ),
    };

    return {
      module: ConversationReadStateModule,
      providers: [service],
      controllers: [ConversationReadStateController],
    };
  }
}
