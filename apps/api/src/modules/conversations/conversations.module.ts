import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  CONVERSATIONS_REPOSITORY,
  CONVERSATIONS_SERVICE,
  MESSAGE_REACTIONS_REPOSITORY,
  MESSAGE_REACTIONS_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import { ConversationsController } from './conversations.controller.js';
import { MessageReactionsRepository } from './message-reactions.repository.js';
import { MessageReactionsService } from './message-reactions.service.js';
import { MessageReactionsController } from './message-reactions.controller.js';

/**
 * CHAT-001's wiring.
 *
 * `ProjectsRepository` and `ProjectMembershipsRepository` are constructed here rather than
 * injected from the module that provides them, which is the choice `RequestsModule` already
 * documents: that module is registered through `.register()`, so importing it would build a
 * second copy of the dynamic module rather than reuse the first. A repository is a stateless
 * collection of queries with no injected dependencies, so a second instance costs nothing and
 * reads honestly — this module owns its own read-only handles on `projects` and
 * `project_memberships`.
 *
 * The service is **not** exported. This aggregate has one door, unlike client requests: there
 * is no client-facing conversation surface, because no client role holds a conversation
 * capability. When one exists it will be a projection on a path of its own, and exporting the
 * internal service is not how it should get there.
 */
@Module({})
export class ConversationsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: CONVERSATIONS_REPOSITORY,
      useFactory: () => new ConversationsRepository(),
    };

    const service: Provider = {
      provide: CONVERSATIONS_SERVICE,
      inject: [TENANT_DATABASE, CONVERSATIONS_REPOSITORY, AUDIT_SERVICE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (
        database: TenantDatabase,
        conversations: ConversationsRepository,
        audit: AuditService,
        outbox: OutboxEventsRepository,
      ) =>
        new ConversationsService(
          database,
          conversations,
          audit,
          new ProjectsRepository(),
          new ProjectMembershipsRepository(),
          // CHAT-003: converting a message files work, and the same reasoning as the two
          // repositories above applies to this one.
          new WorkItemsRepository(),
          outbox,
        ),
    };

    // x246 message reactions. Its own repository and service, registered alongside the
    // conversation aggregate they hang off. The service reuses `ConversationsRepository` to
    // resolve the conversation, its membership and the message before its own gate decides
    // anything — the same stateless-repository reasoning the providers above give.
    const reactionsRepository: Provider = {
      provide: MESSAGE_REACTIONS_REPOSITORY,
      useFactory: () => new MessageReactionsRepository(),
    };

    const reactionsService: Provider = {
      provide: MESSAGE_REACTIONS_SERVICE,
      inject: [TENANT_DATABASE, CONVERSATIONS_REPOSITORY, MESSAGE_REACTIONS_REPOSITORY],
      useFactory: (
        database: TenantDatabase,
        conversations: ConversationsRepository,
        reactions: MessageReactionsRepository,
      ) => new MessageReactionsService(database, conversations, reactions),
    };

    return {
      module: ConversationsModule,
      providers: [repository, service, reactionsRepository, reactionsService],
      controllers: [ConversationsController, MessageReactionsController],
    };
  }
}
