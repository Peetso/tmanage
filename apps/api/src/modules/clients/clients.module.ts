import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  API_CONFIG,
  AUDIT_SERVICE,
  CLIENTS_SERVICE,
  CLIENT_MEMBERSHIPS_REPOSITORY,
  CLIENT_ORGANIZATIONS_REPOSITORY,
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

    return {
      module: ClientsModule,
      providers: [organizations, memberships, shares, service],
      exports: [service],
      controllers: [ClientsController],
    };
  }
}
