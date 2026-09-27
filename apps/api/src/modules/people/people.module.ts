import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MEMBERSHIPS_REPOSITORY,
  PERSON_ALLOCATIONS_REPOSITORY,
  PROJECTS_REPOSITORY,
} from '../../common/http/tokens.js';
import { PersonAllocationsRepository } from './allocations.repository.js';
import { PersonAllocationsController } from './allocations.controller.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';

/**
 * PEOPLE / module 14 (x171). The people module — a project's people allocations (assign, list).
 *
 * The controller carries the orchestration itself (resolve both ids tenant-scoped, `authorize()`,
 * validate, one-active-per-pair, write), so this module wires three stateless repositories under their
 * tokens: the allocations repository, plus a `ProjectsRepository` and a `MembershipsRepository` to
 * resolve the two ids the request names inside the tenant before the write (so an unknown or
 * cross-tenant id is a 404, not a foreign-key 500). Each is stateless and holds no connection, so a
 * module-local instance is correct even where another module also provides the same token.
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

    return {
      module: PeopleModule,
      providers: [allocationsRepository, projectsRepository, membershipsRepository],
      controllers: [PersonAllocationsController],
    };
  }
}
