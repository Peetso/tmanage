import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  INBOX_SERVICE,
  MALWARE_SCANNER,
  NOTIFICATIONS_REPOSITORY,
  OBJECT_STORE,
  OUTBOX_EVENTS_REPOSITORY,
  PORTAL_INBOX_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import { StorageAllowanceService } from '../billing/storage-allowance.service.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { ObjectStore } from '@tmanage/storage';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import { FileDownloadService } from '../files/file-download.service.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { providerObjectSources } from '../files/provider-object-sources.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import { ClientRequestsService } from '../requests/client-requests.service.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkItemsService } from '../work/work-items.service.js';
import { InboxController } from './inbox.controller.js';
import { InboxService } from './inbox.service.js';
import { InboxSnoozeRepository } from './inbox-snooze.repository.js';
import { createInboxObjectResolvers } from './inbox-object-resolvers.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { DocumentsService } from '../docs/documents.service.js';
import { MeetingsService } from '../calendar/meetings.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { NotificationsRepository } from './notifications.repository.js';
import { InboxSourceMutesController } from './source-mutes.controller.js';
import { InboxSourceMutesRepository } from './source-mutes.repository.js';
import { InboxSourceMutesService, INBOX_SOURCE_MUTES_SERVICE } from './source-mutes.service.js';

/** Module-local: the shared `ClientRequestsService` both inbox services read through. */
const INBOX_CLIENT_REQUESTS = Symbol('tmanage.InboxModule.ClientRequestsService');
import { PortalInboxController } from './portal-inbox.controller.js';
import { PortalInboxService, portalInboxFileReader } from './portal-inbox.service.js';
import { InboxRulesController, INBOX_RULES_SERVICE } from './rules.controller.js';
import { InboxRulesService } from './rules.service.js';
import { InboxRulesRepository } from './rules.repository.js';

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
          { quota: new StorageAllowanceService(database, config.storageOrgBytesLimit) },
          // CQ-12: mentions, comments, invites, project adds and rule test runs, each resolved
          // through the object's own authorized read. Read-only use: no outbox or audit needed.
          createInboxObjectResolvers({
            database,
            conversations: new ConversationsService(database),
            documents: new DocumentsService(database),
            meetings: new MeetingsService(database),
            projects: new ProjectsService(database),
          }),
          // 2026-10-31 live test: a snoozed bundle leaves the list until its time comes.
          new InboxSnoozeRepository(),
        ),
    };

    const portal: Provider = {
      provide: PORTAL_INBOX_SERVICE,
      inject: [
        TENANT_DATABASE,
        NOTIFICATIONS_REPOSITORY,
        INBOX_CLIENT_REQUESTS,
        OBJECT_STORE,
        AUDIT_SERVICE,
        MALWARE_SCANNER,
        { token: API_CONFIG, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        notifications: NotificationsRepository,
        requests: ClientRequestsService,
        store: ObjectStore,
        audit: AuditService,
        malwareScanner: MalwareScanner,
        config: ApiConfig | undefined,
      ) =>
        new PortalInboxService(
          database,
          requests,
          notifications,
          // R4 Batch F follow-up: file review notices (V-50), each re-read through the download
          // door the portal viewer opens a file by. Constructed here for this module's reason
          // above: FilesModule is registered through .register(). Read-only; a refusal is the
          // door's own audited 404.
          portalInboxFileReader(
            new FileDownloadService(
              database,
              new FileAssetsRepository(),
              new ProjectsRepository(),
              new ClientRequestsRepository(),
              store,
              audit,
              malwareScanner,
              undefined,
              undefined,
              config ? providerObjectSources(database, audit, config) : {},
            ),
          ),
        ),
    };

    // INBOX-001 per-user routing rules (x301). Self-scoped GET/POST/DELETE plus a read-side resolve
    // helper over the caller's own rules and notifications. Wired here because it shares this module's
    // `NOTIFICATIONS_REPOSITORY` for the resolution read; its own rules store is constructed inline,
    // stateless over the tenant database like the reads this module already performs.
    const rules: Provider = {
      provide: INBOX_RULES_SERVICE,
      inject: [TENANT_DATABASE, NOTIFICATIONS_REPOSITORY],
      useFactory: (database: TenantDatabase, notifications: NotificationsRepository) =>
        new InboxRulesService(database, new InboxRulesRepository(), notifications),
    };

    // x318 — a member's own inbox source mutes (a self-scoped read-side filter). Wired here rather
    // than in a module of its own: it depends on nothing but the tenant database and is file-disjoint
    // from every other inbox slice. `work.read`, `context.userId`-scoped throughout.
    const sourceMutes: Provider = {
      provide: INBOX_SOURCE_MUTES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InboxSourceMutesService(database, new InboxSourceMutesRepository()),
    };

    return {
      module: InboxModule,
      providers: [repository, clientRequests, service, portal, rules, sourceMutes],
      exports: [service, portal],
      controllers: [
        InboxController,
        PortalInboxController,
        InboxRulesController,
        InboxSourceMutesController,
      ],
    };
  }
}
