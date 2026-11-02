import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MEMBERSHIPS_REPOSITORY,
  PERSON_ALLOCATIONS_REPOSITORY,
  PROJECTS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { PersonAllocationsRepository } from './allocations.repository.js';
import { PersonAllocationsController } from './allocations.controller.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { PeopleDirectoryRepository } from './directory.repository.js';
import { PeopleDirectoryController } from './directory.controller.js';
import { ContactSuggestionsController } from './contact-suggestions.controller.js';
import { ContactSuggestionsRepository } from './contact-suggestions.repository.js';
import { ContactSuggestionsService } from './contact-suggestions.service.js';

/**
 * PEOPLE / module 14.
 *
 * (x171) People allocations (assign, list). The controller carries the orchestration itself (resolve
 * both ids tenant-scoped, `authorize()`, validate, one-active-per-pair, write), so this module wires
 * three stateless repositories under their tokens: the allocations repository, plus a
 * `ProjectsRepository` and a `MembershipsRepository` to resolve the two ids the request names inside
 * the tenant before the write (so an unknown or cross-tenant id is a 404, not a foreign-key 500).
 *
 * (x168) People & capacity directory — the org member directory with a per-person project count,
 * behind the reused `work.read`. Read-only over `memberships` + `users` + `project_memberships`; its
 * own stateless `PeopleDirectoryRepository`, resolving `TENANT_DATABASE` for the read. No new table.
 * Both surfaces share this one module so the People slices stay file-disjoint in `app.module.ts`.
 *
 * (R16-f, 54-11 Phase 0) The caller's own invite suggestions imported from a contacts file: a
 * stateless repository and a service over the `@Global` `TENANT_DATABASE` (0295).
 */
@Module({})
export class PeopleModule {
  static register(): DynamicModule {
    const allocationsRepository: Provider = {
      provide: PERSON_ALLOCATIONS_REPOSITORY,
      useFactory: () => new PersonAllocationsRepository(),
    };
    const projectsRepository: Provider = {
      provide: PROJECTS_REPOSITORY,
      useFactory: () => new ProjectsRepository(),
    };
    const membershipsRepository: Provider = {
      provide: MEMBERSHIPS_REPOSITORY,
      useFactory: () => new MembershipsRepository(),
    };
    const directoryRepository: Provider = {
      provide: PeopleDirectoryRepository,
      useValue: new PeopleDirectoryRepository(),
    };

    const contactSuggestionsService: Provider = {
      provide: ContactSuggestionsService,
      useFactory: (database: TenantDatabase) =>
        new ContactSuggestionsService(database, new ContactSuggestionsRepository()),
      inject: [TENANT_DATABASE],
    };

    return {
      module: PeopleModule,
      providers: [
        allocationsRepository,
        projectsRepository,
        membershipsRepository,
        directoryRepository,
        contactSuggestionsService,
      ],
      controllers: [
        PersonAllocationsController,
        PeopleDirectoryController,
        ContactSuggestionsController,
      ],
    };
  }
}
