import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import { ConversationSearchRepository } from './conversation-search.repository.js';
import { ConversationSearchService } from './conversation-search.service.js';
import {
  CONVERSATION_SEARCH_SERVICE,
  ConversationSearchController,
} from './conversation-search.controller.js';

/**
 * CH-10 "Search in conversation" (x253) wiring.
 *
 * The gate is reused, not re-implemented: this module builds its own read-only
 * `ConversationsService` — the same way `ConversationsModule` builds one — so
 * {@link ConversationSearchService} can resolve-and-authorise a conversation through
 * `ConversationsService.get` (the authoritative `conversation.read` + channel-membership check)
 * before it reads any message. A second instance costs nothing here: `get` writes nothing, and
 * the repositories it leans on are stateless, so the audit/outbox handles the running
 * conversation service holds are irrelevant to a read.
 *
 * Registered additively in `app.module.ts` beside `ConversationsModule`; its controller mounts
 * under `…/conversations/:conversationId/messages/search`, a distinct literal path, so this
 * slice's files are disjoint from every other module's.
 */
@Module({})
export class ConversationSearchModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: CONVERSATION_SEARCH_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ConversationSearchService(
          database,
          new ConversationsService(database, new ConversationsRepository()),
          new ConversationSearchRepository(),
        ),
    };

    return {
      module: ConversationSearchModule,
      providers: [service],
      controllers: [ConversationSearchController],
    };
  }
}
