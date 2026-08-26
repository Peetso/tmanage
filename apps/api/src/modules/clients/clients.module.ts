import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  CLIENTS_SERVICE,
  CLIENT_REQUESTS_SERVICE,
  CLIENT_MEMBERSHIPS_REPOSITORY,
  CLIENT_ORGANIZATIONS_REPOSITORY,
  INVITATIONS_SERVICE,
  PORTAL_SERVICE,
  PROJECT_CLIENTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ClientMembershipsRepository } from './client-memberships.repository.js';
import { ClientOrganizationsRepository } from './client-organizations.repository.js';
import { ProjectClientsRepository } from './project-clients.repository.js';
import { ClientsService } from './clients.service.js';
import { ClientsController } from './clients.controller.js';
import { PortalService } from './portal.service.js';
import { PortalController } from './portal.controller.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
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

    const portal: Provider = {
      provide: PORTAL_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        // Both repositories constructed here, for the reason the service above constructs its
        // own `ProjectsRepository`: they are stateless collections of queries, and reaching
        // for another module's provider would register that dynamic module twice.
        new PortalService(database, new ProjectsRepository(), new WorkItemsRepository()),
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
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new InvitationsService(
          database,
          new InvitationsRepository(),
          new MembershipsRepository(),
          new ClientMembershipsRepository(),
          audit,
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
     */
    const clientRequests: Provider = {
      provide: CLIENT_REQUESTS_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new ClientRequestsService(
          database,
          new ClientRequestsRepository(),
          audit,
          new ProjectsRepository(),
          new WorkItemsRepository(),
          new ClientOrganizationsRepository(),
        ),
    };

    return {
      module: ClientsModule,
      providers: [organizations, memberships, shares, service, portal, invitations, clientRequests],
      exports: [service, portal],
      controllers: [ClientsController, PortalController],
    };
  }
}
