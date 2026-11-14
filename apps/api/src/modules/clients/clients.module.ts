import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  CLIENTS_SERVICE,
  CLIENT_MESSAGES_SERVICE,
  CLIENT_REQUESTS_SERVICE,
  CLIENT_MEMBERSHIPS_REPOSITORY,
  CLIENT_ORGANIZATIONS_REPOSITORY,
  INVITATION_MAILER,
  INVITATIONS_SERVICE,
  MALWARE_SCANNER,
  MILESTONE_LIFECYCLE_SERVICE,
  OUTBOX_EVENTS_REPOSITORY,
  PORTAL_ACCESS_LOG_SERVICE,
  PORTAL_ANNOUNCEMENTS_SERVICE,
  PORTAL_SERVICE,
  PROJECT_CLIENTS_REPOSITORY,
  PROJECT_MILESTONES_SERVICE,
  PROJECT_RISKS_SERVICE,
  TENANT_DATABASE,
  UPDATE_COMMENTS_SERVICE,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { MalwareScanner } from '../../common/scan/malware-scanner.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import type { InvitationMailer } from '../../common/email/invitation-mailer.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ClientMembershipsRepository } from './client-memberships.repository.js';
import { ClientOrganizationsRepository } from './client-organizations.repository.js';
import { ProjectClientsRepository } from './project-clients.repository.js';
import { ClientsService } from './clients.service.js';
import { ClientsController } from './clients.controller.js';
import { PortalService } from './portal.service.js';
import { PortalController } from './portal.controller.js';
import { ProjectUpdatesController } from './project-updates.controller.js';
import { UpdateLifecycleController } from './update-lifecycle.controller.js';
import { ProjectUpdatesRepository } from './project-updates.repository.js';
import {
  PortalUpdateCommentsController,
  ProjectUpdateCommentsController,
} from './update-comments.controller.js';
import { UpdateCommentsService } from './update-comments.service.js';
import { ProjectUpdateCommentsRepository } from './update-comments.repository.js';
import { PortalAnnouncementsController } from './portal-announcements.controller.js';
import { PortalAnnouncementsService } from './portal-announcements.service.js';
import { PortalAnnouncementsRepository } from './portal-announcements.repository.js';
import { PortalClientMessagesController } from './client-messages.controller.js';
import { ClientMessagesService } from './client-messages.service.js';
import { ClientMessagesRepository } from './client-messages.repository.js';
import {
  PortalMilestonesController,
  ProjectMilestonesController,
  ProjectMilestonesService,
} from './project-milestones.controller.js';
import {
  MilestoneLifecycleController,
  MilestoneLifecycleService,
} from './milestone-lifecycle.controller.js';
import { ProjectMilestonesRepository } from './project-milestones.repository.js';
import {
  PortalRisksController,
  ProjectRisksController,
  ProjectRisksService,
} from './project-risks.controller.js';
import { ProjectRisksRepository } from './project-risks.repository.js';
import {
  PortalAccessLogController,
  PortalAccessLogService,
} from './portal-access-log.controller.js';
import { PortalAccessLogRepository } from './portal-access-log.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import { FileAssetsRepository } from '../files/file-assets.repository.js';
import { ClientFileSharing } from '../files/client-file-sharing.js';
import { ReviewThreadsRepository } from '../files/review-threads.repository.js';
import { InvitationsRepository } from '../tenancy/invitations.repository.js';
import { InvitationsService } from '../tenancy/invitations.service.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import { ClientRequestsService } from '../requests/client-requests.service.js';

/**
 * CLIENT-001's wiring.
 *
 * The three repositories are provided rather than defaulted inside the service so that the
 * database suite can substitute one and watch what the service does with it — the same reason
 * every other module here does it.
 *
 * `ProjectsRepository` is injected read-only: the service reads a project to answer 404 rather
 * than 500 when a caller shares something that is not in this tenant. It does not write to
 * `projects` and has no route that could.
 */
@Module({})
export class ClientsModule {
  static register(): DynamicModule {
    const organizations: Provider = {
      provide: CLIENT_ORGANIZATIONS_REPOSITORY,
      useFactory: () => new ClientOrganizationsRepository(),
    };

    const memberships: Provider = {
      provide: CLIENT_MEMBERSHIPS_REPOSITORY,
      useFactory: () => new ClientMembershipsRepository(),
    };

    const shares: Provider = {
      provide: PROJECT_CLIENTS_REPOSITORY,
      useFactory: () => new ProjectClientsRepository(),
    };

    const service: Provider = {
      provide: CLIENTS_SERVICE,
      inject: [
        TENANT_DATABASE,
        API_CONFIG,
        CLIENT_ORGANIZATIONS_REPOSITORY,
        CLIENT_MEMBERSHIPS_REPOSITORY,
        PROJECT_CLIENTS_REPOSITORY,
        AUDIT_SERVICE,
      ],
      useFactory: (
        database: TenantDatabase,
        config: ApiConfig,
        clientOrganizations: ClientOrganizationsRepository,
        clientMemberships: ClientMembershipsRepository,
        projectClients: ProjectClientsRepository,
        audit: AuditService,
      ) =>
        new ClientsService(
          database,
          { defaultExpiryDays: config.clientMembershipDefaultExpiryDays },
          clientOrganizations,
          clientMemberships,
          projectClients,
          // Constructed here rather than injected from `ProjectsModule`. That module provides
          // `PROJECTS_REPOSITORY` and does not export it, and both modules are registered
          // through `.register()` — so importing it here would build a second copy of the
          // dynamic module rather than reuse the first. A repository is a stateless collection
          // of queries with no injected dependencies, so a second instance costs nothing and
          // reads honestly: this module owns its own read-only handle on `projects`.
          new ProjectsRepository(),
          audit,
        ),
    };

    /**
     * SEC / Client portal access log (x237). The record + internal-audit-read service. The
     * repositories are constructed here, like the `portal` provider below: they are stateless
     * collections of queries, and reaching for another module's provider would register that
     * dynamic module twice.
     */
    const accessLog: Provider = {
      provide: PORTAL_ACCESS_LOG_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new PortalAccessLogService(
          database,
          new ProjectsRepository(),
          new PortalAccessLogRepository(),
        ),
    };

    const portal: Provider = {
      provide: PORTAL_SERVICE,
      // x237: the access-log service is injected as the recorder, so a successful client read of a
      // deliverable or update logs one access event (best-effort; a logging failure never denies
      // the read).
      inject: [TENANT_DATABASE, PORTAL_ACCESS_LOG_SERVICE, MALWARE_SCANNER],
      useFactory: (
        database: TenantDatabase,
        recorder: PortalAccessLogService,
        scanner: MalwareScanner,
      ) =>
        // Every repository constructed here, for the reason the service above constructs its
        // own `ProjectsRepository`: they are stateless collections of queries, and reaching
        // for another module's provider would register that dynamic module twice. x114 adds the
        // read-only client-projection and file-asset repositories for the deliverables surface.
        new PortalService(
          database,
          new ProjectsRepository(),
          new WorkItemsRepository(),
          new ClientProjectionsRepository(),
          new FileAssetsRepository(),
          new ProjectUpdatesRepository(),
          recorder,
          new ReviewThreadsRepository(),
          // FIX6 item 1: the scanner, so the deliverable file list obeys the one sharing rule.
          new ClientFileSharing(scanner),
        ),
    };

    /**
     * The portal's own `InvitationsService`.
     *
     * `TenancyModule` provides one and exports it, and both modules are registered through
     * `.register()` — so importing that module here would construct a second copy of the
     * dynamic module rather than reuse the first. The service holds no state between calls: it
     * is a set of commands over repositories that are themselves stateless, so a second
     * instance behaves identically and shares the same database and audit service.
     *
     * The alternative was to put `CL-11`'s route in `TenancyModule` beside the internal
     * invitation routes, and that would have been worse: the whole point of the route is that
     * it is a **portal** surface whose body cannot name a client organization, and burying it
     * among the internal administrator's routes is how that distinction gets lost.
     */
    const invitations: Provider = {
      provide: INVITATIONS_SERVICE,
      // `INVITATION_MAILER` too: this second instance serves the portal's CL-11 route, and
      // a client admin's invitation deserves the same email an internal one gets. The first
      // review of the mailer slice found this copy still built with five arguments — with
      // SMTP fully configured, portal invitations silently answered `delivery: 'none'`.
      inject: [TENANT_DATABASE, AUDIT_SERVICE, INVITATION_MAILER],
      useFactory: (
        database: TenantDatabase,
        audit: AuditService,
        invitationMail: InvitationMailer,
      ) =>
        new InvitationsService(
          database,
          new InvitationsRepository(),
          new MembershipsRepository(),
          new ClientMembershipsRepository(),
          audit,
          invitationMail,
        ),
    };

    /**
     * The portal's own `ClientRequestsService` — REQ-001's client half.
     *
     * Constructed here for the reason `invitations` above is: `RequestsModule` provides and
     * exports one, and both modules are registered through `.register()`, so importing it would
     * build a second copy of the dynamic module rather than reuse the first. The service holds
     * no state between calls.
     *
     * The alternative was to put `CL-06`'s routes on `ClientRequestsController` beside the
     * studio's triage routes, and that would have been worse for the reason this file's portal
     * provider exists at all: a client surface is a **path of its own** serving a projection,
     * and a client route living among the internal ones is how that stops being true.
     *
     * **With the outbox.** Until 2026-09-02 this copy was built without it, and the service's
     * `append` is optional-chained — so a request submitted or withdrawn *through the portal*
     * wrote no `client_request.submitted.v1`, no manager was notified and no mail composed,
     * while the same request submitted by the database suites (which construct the service
     * with the outbox) did. E2E-07's first run found it: the studio's inbox stayed empty after
     * the relay ran. The database case that pins it is in `inbox-001-portal-inbox.db.test.ts`.
     */
    const clientRequests: Provider = {
      provide: CLIENT_REQUESTS_SERVICE,
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

    /**
     * SEC / Portal milestones (x139). The repositories are constructed here, like the `portal`
     * provider above: they are stateless collections of queries, and reaching for another
     * module's provider would register that dynamic module twice.
     */
    const milestones: Provider = {
      provide: PROJECT_MILESTONES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ProjectMilestonesService(
          database,
          new ProjectsRepository(),
          new ProjectMilestonesRepository(),
        ),
    };

    /**
     * SEC / Portal milestone lifecycle (x202). Edit and complete an existing milestone. Its own
     * service beside x139's create/read one; the repositories are constructed here, like the
     * `milestones` provider above, for the same reason.
     */
    const milestoneLifecycle: Provider = {
      provide: MILESTONE_LIFECYCLE_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, OUTBOX_EVENTS_REPOSITORY],
      useFactory: (database: TenantDatabase, audit: AuditService, outbox: OutboxEventsRepository) =>
        new MilestoneLifecycleService(
          database,
          new ProjectsRepository(),
          new ProjectMilestonesRepository(),
          undefined,
          undefined,
          undefined,
          audit,
          outbox,
        ),
    };

    /**
     * SEC / Portal risks (x140). The repositories are constructed here, like the `portal` provider
     * above: they are stateless collections of queries, and reaching for another module's provider
     * would register that dynamic module twice.
     */
    const risks: Provider = {
      provide: PROJECT_RISKS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ProjectRisksService(database, new ProjectsRepository(), new ProjectRisksRepository()),
    };

    /**
     * SEC / Portal update comments (x203). The repositories are constructed here, like the `portal`
     * provider above: they are stateless collections of queries, and reaching for another module's
     * provider would register that dynamic module twice.
     */
    const updateComments: Provider = {
      provide: UPDATE_COMMENTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new UpdateCommentsService(
          database,
          new ProjectUpdatesRepository(),
          new ProjectUpdateCommentsRepository(),
        ),
    };

    /**
     * POR client portal (x304). Portal announcement banners: internal create/delete + client read.
     * The repositories are constructed here, like the `portal` provider above — stateless collections
     * of queries, and reaching for another module's provider would register that dynamic module twice.
     */
    const portalAnnouncements: Provider = {
      provide: PORTAL_ANNOUNCEMENTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new PortalAnnouncementsService(
          database,
          new ClientOrganizationsRepository(),
          new PortalAnnouncementsRepository(),
        ),
    };

    /**
     * SEC / Client portal messages (x322). The repositories are constructed here, like the `portal`
     * provider above: they are stateless collections of queries, and reaching for another module's
     * provider would register that dynamic module twice.
     */
    const clientMessages: Provider = {
      provide: CLIENT_MESSAGES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new ClientMessagesService(
          database,
          new ClientOrganizationsRepository(),
          new ClientMessagesRepository(),
        ),
    };

    return {
      module: ClientsModule,
      providers: [
        organizations,
        memberships,
        shares,
        service,
        accessLog,
        portal,
        invitations,
        clientRequests,
        milestones,
        milestoneLifecycle,
        risks,
        updateComments,
        portalAnnouncements,
        clientMessages,
      ],
      exports: [service, portal],
      controllers: [
        ClientsController,
        PortalController,
        ProjectUpdatesController,
        UpdateLifecycleController,
        ProjectMilestonesController,
        PortalMilestonesController,
        MilestoneLifecycleController,
        ProjectRisksController,
        PortalRisksController,
        PortalAccessLogController,
        ProjectUpdateCommentsController,
        PortalUpdateCommentsController,
        PortalAnnouncementsController,
        PortalClientMessagesController,
      ],
    };
  }
}
