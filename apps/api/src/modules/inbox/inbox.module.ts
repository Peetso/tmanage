import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  INBOX_SERVICE,
  NOTIFICATIONS_REPOSITORY,
  OUTBOX_EVENTS_REPOSITORY,
  PORTAL_INBOX_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
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

/** Module-local: the shared `ClientRequestsService` both inbox services read through. */
const INBOX_CLIENT_REQUESTS = Symbol('tmanage.InboxModule.ClientRequestsService');
import { PortalInboxController } from './portal-inbox.controller.js';
import { PortalInboxService } from './portal-inbox.service.js';

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
 *
 * The second half — the client's inbox on the portal path — is wired here too. Both halves
 * read through one module-local `ClientRequestsService` (the internal inbox its `get`, the
 * portal inbox its `getForClient`), which is the same stateless instance either would have
 * built alone. They share the repository that names a recipient and no other code path; that
 * separation is the point of a portal route, and keeping both in one module is a wiring
 * convenience that does not blur it.
 */
@Module({})
export class InboxModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: NOTIFICATIONS_REPOSITORY,
      useFactory: () => new NotificationsRepository(),
    };

    // One authorized reader of client requests, shared by both halves: the internal inbox
    // calls its `get`, the portal inbox its `getForClient`. Module-local, because exporting it
    // under `CLIENT_REQUESTS_SERVICE` would collide with the copies `RequestsModule` and
    // `ClientsModule` each own.
    const clientRequests: Provider = {
      provide: INBOX_CLIENT_REQUESTS,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (database: TenantDatabase, audit: AuditService, outbox: OutboxEventsRepository) =>
        new ClientRequestsService(
          database,
          new ClientRequestsRepository(),
          audit,
          new ProjectsRepository(),
          new WorkItemsRepository(),
          new ClientOrganizationsRepository(),
          outbox,
        ),
    };

    const service: Provider = {
      provide: INBOX_SERVICE,
      inject: [
        TENANT_DATABASE,
        AUDIT_SERVICE,
        OUTBOX_EVENTS_REPOSITORY,
        NOTIFICATIONS_REPOSITORY,
        INBOX_CLIENT_REQUESTS,
        API_CONFIG,
      ],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        outbox: OutboxEventsRepository,
        notifications: NotificationsRepository,
        requests: ClientRequestsService,
        config: ApiConfig,
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
          requests,
          notifications,
          // USAGE-001 slice 4b: the effective storage quota the reservation guard uses, so the
          // inbox can render "Storage at 85 % — 8.5 GB of 10 GB" for an owner/admin.
          { quotaBytes: config.storageOrgBytesLimit },
        ),
    };

    const portal: Provider = {
      provide: PORTAL_INBOX_SERVICE,
      inject: [TENANT_DATABASE, NOTIFICATIONS_REPOSITORY, INBOX_CLIENT_REQUESTS],
      useFactory: (
        database: TenantDatabase,
        notifications: NotificationsRepository,
        requests: ClientRequestsService,
      ) => new PortalInboxService(database, requests, notifications),
    };

    return {
      module: InboxModule,
      providers: [repository, clientRequests, service, portal],
      exports: [service, portal],
      controllers: [InboxController, PortalInboxController],
    };
  }
}
