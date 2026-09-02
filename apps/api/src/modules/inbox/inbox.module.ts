import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  INBOX_SERVICE,
  NOTIFICATIONS_REPOSITORY,
  OUTBOX_EVENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import { ClientRequestsService } from '../requests/client-requests.service.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkItemsService } from '../work/work-items.service.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';
import { NotificationsRepository } from './notifications.repository.js';

/**
 * INBOX-001's wiring.
 *
 * The inbox resolves every notification's object by the ordinary authorized read —
 * `WorkItemsService.get`, `ClientRequestsService.get` — and has no read path of its own to
 * the objects. Those two services are **constructed here** rather than injected from
 * `WorkModule` and `RequestsModule`, for the reason `ClientsModule` and `ConversationsModule`
 * already document: both are registered through `.register()`, so importing either would
 * build a second copy of the dynamic module — controllers and all — rather than reuse the
 * first. The services are stateless over the same global handles (`TENANT_DATABASE`,
 * `AUDIT_SERVICE`, `OUTBOX_EVENTS_REPOSITORY`), so a second instance answers `get` exactly as
 * the first does, and the reads this module performs never write: the audit and outbox
 * handles are wired because the constructors take them, not because the inbox uses them.
 */
@Module({})
export class InboxModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: NOTIFICATIONS_REPOSITORY,
      useFactory: () => new NotificationsRepository(),
    };

    const service: Provider = {
      provide: INBOX_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, OUTBOX_EVENTS_REPOSITORY, NOTIFICATIONS_REPOSITORY],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        outbox: OutboxEventsRepository,
        notifications: NotificationsRepository,
      ) =>
        new InboxService(
          database,
          new WorkItemsService(
            database,
            new WorkItemsRepository(),
            audit,
            new ProjectsRepository(),
            outbox,
          ),
          new ClientRequestsService(
            database,
            new ClientRequestsRepository(),
            audit,
            new ProjectsRepository(),
            new WorkItemsRepository(),
            new ClientOrganizationsRepository(),
            outbox,
          ),
          notifications,
        ),
    };

    return {
      module: InboxModule,
      providers: [repository, service],
      exports: [service],
      controllers: [InboxController],
    };
  }
}
