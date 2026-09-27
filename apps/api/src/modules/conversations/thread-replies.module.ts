import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { TENANT_DATABASE, THREAD_REPLIES_SERVICE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ThreadRepliesRepository } from './thread-replies.repository.js';
import { ThreadRepliesService } from './thread-replies.service.js';
import { ThreadRepliesController } from './thread-replies.controller.js';

/**
 * x249's wiring.
 *
 * A module of its own rather than a second door on `ConversationsModule`: this surface owns a
 * separate append-only table and does not touch the conversation aggregate's writes, so it
 * carries its own read-only `ConversationsRepository` handle — the same reasoning
 * `ConversationsModule` records for owning its own `ProjectsRepository`. The service is not
 * exported: like conversations, this aggregate has one door and no client-facing projection.
 */
@Module({})
export class ThreadRepliesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: THREAD_REPLIES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ThreadRepliesService(
          database,
          new ConversationsRepository(),
          new ThreadRepliesRepository(),
        ),
    };

    return {
      module: ThreadRepliesModule,
      providers: [service],
      controllers: [ThreadRepliesController],
    };
  }
}
