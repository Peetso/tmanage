import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  CLIENT_REQUESTS_REPOSITORY,
  CLIENT_REQUESTS_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  REQUEST_COMMENTS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import { ClientRequestsRepository } from './client-requests.repository.js';
import { ClientRequestsService } from './client-requests.service.js';
import { ClientRequestsController } from './client-requests.controller.js';
import { RequestCommentsRepository } from './request-comments.repository.js';
import { RequestCommentsService } from './request-comments.service.js';
import { RequestCommentsController } from './request-comments.controller.js';
import { RequestMessagesRepository } from './request-messages.repository.js';
import { REQUEST_MESSAGES_SERVICE, RequestMessagesService } from './request-messages.service.js';
import {
  PortalRequestMessagesController,
  RequestMessagesController,
} from './request-messages.controller.js';

/**
 * REQ-001's wiring — the studio's half.
 *
 * `ProjectsRepository` and `WorkItemsRepository` are constructed here rather than injected from
 * the modules that provide them, which is the choice `ClientsModule` already documents: both of
 * those modules are registered through `.register()`, so importing one would build a second
 * copy of the dynamic module rather than reuse the first. A repository is a stateless collection
 * of queries with no injected dependencies, so a second instance costs nothing and reads
 * honestly — this module owns its own read-only handles on `projects` and `work_items`.
 *
 * The service is exported because the aggregate has a second door. The client's routes are on
 * `/portal/requests`, in `ClientsModule`, for the security reason `PortalController` sets out:
 * a client surface is a path of its own rather than a query parameter on an internal one.
 */
@Module({})
export class RequestsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: CLIENT_REQUESTS_REPOSITORY,
      useFactory: () => new ClientRequestsRepository(),
    };

    const service: Provider = {
      provide: CLIENT_REQUESTS_SERVICE,
      inject: [
        TENANT_DATABASE,
        CLIENT_REQUESTS_REPOSITORY,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
      ],
      useFactory: (
        database: TenantDatabase,
        requests: ClientRequestsRepository,
        audit: AuditService,
        outbox: OutboxEventsRepository,
      ) =>
        new ClientRequestsService(
          database,
          requests,
          audit,
          new ProjectsRepository(),
          new WorkItemsRepository(),
          new ClientOrganizationsRepository(),
          outbox,
        ),
    };

    // x299 — a client request's internal comment thread. Registered here (the shared append point)
    // rather than in a module of its own, alongside the request aggregate it hangs off. The service
    // reuses the request repository to resolve the parent request tenant-scoped before it writes.
    const commentsService: Provider = {
      provide: REQUEST_COMMENTS_SERVICE,
      inject: [TENANT_DATABASE, CLIENT_REQUESTS_REPOSITORY],
      useFactory: (database: TenantDatabase, requests: ClientRequestsRepository) =>
        new RequestCommentsService(database, requests, new RequestCommentsRepository()),
    };

    // 0212 (audit gap 4) — the client <-> studio thread on a request, both doors. Posts append
    // `client_request.message_posted.v1` to the outbox in the same transaction.
    const messagesService: Provider = {
      provide: REQUEST_MESSAGES_SERVICE,
      inject: [TENANT_DATABASE, CLIENT_REQUESTS_REPOSITORY, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (
        database: TenantDatabase,
        requests: ClientRequestsRepository,
        outbox: OutboxEventsRepository,
      ) => new RequestMessagesService(database, requests, new RequestMessagesRepository(), outbox),
    };

    return {
      module: RequestsModule,
      providers: [repository, service, commentsService, messagesService],
      exports: [service],
      controllers: [
        ClientRequestsController,
        RequestCommentsController,
        RequestMessagesController,
        PortalRequestMessagesController,
      ],
    };
  }
}
