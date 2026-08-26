import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  CONVERSATIONS_REPOSITORY,
  CONVERSATIONS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import { ConversationsController } from './conversations.controller.js';

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
      inject: [TENANT_DATABASE, CONVERSATIONS_REPOSITORY, AUDIT_SERVICE],
      useFactory: (
        database: TenantDatabase,
        conversations: ConversationsRepository,
        audit: AuditService,
      ) =>
        new ConversationsService(
          database,
          conversations,
          audit,
          new ProjectsRepository(),
          new ProjectMembershipsRepository(),
        ),
    };

    return {
      module: ConversationsModule,
      providers: [repository, service],
      controllers: [ConversationsController],
    };
  }
}
