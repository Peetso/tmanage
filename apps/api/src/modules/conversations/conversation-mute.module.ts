import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  CONVERSATION_MUTE_REPOSITORY,
  CONVERSATION_MUTE_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationMuteRepository } from './conversation-mute.repository.js';
import { ConversationMuteService } from './conversation-mute.service.js';
import { ConversationMuteController } from './conversation-mute.controller.js';

/**
 * CH-09 conversation-mute wiring (module Chat, x252).
 *
 * File-disjoint from `ConversationsModule` so neither slice edits a file the other appends to. The
 * service reuses `ConversationsRepository` to resolve and authorize the conversation before it reads
 * or writes the mute row; that repository is a stateless collection of queries, so it is constructed
 * here — the same choice `ConversationsModule` documents, where importing the dynamic module would
 * build a second copy of it rather than reuse the first. Every provider carries an explicit token
 * (ADR-0003). The mute store is the caller's-own GET/PUT routes over `TENANT_DATABASE`.
 */
@Module({})
export class ConversationMuteModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: CONVERSATION_MUTE_REPOSITORY,
      useFactory: () => new ConversationMuteRepository(),
    };

    const service: Provider = {
      provide: CONVERSATION_MUTE_SERVICE,
      inject: [TENANT_DATABASE, CONVERSATION_MUTE_REPOSITORY],
      useFactory: (database: TenantDatabase, mutes: ConversationMuteRepository) =>
        new ConversationMuteService(database, mutes, new ConversationsRepository()),
    };

    return {
      module: ConversationMuteModule,
      providers: [repository, service],
      controllers: [ConversationMuteController],
    };
  }
}
