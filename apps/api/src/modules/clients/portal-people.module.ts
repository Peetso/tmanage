import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { PortalPeopleController } from './portal-people.controller.js';
import { PortalPeopleProjection } from './portal-people.projection.js';

/**
 * The portal-people read's wiring — module 13, x142.
 *
 * A module of its own rather than another entry in `ClientsModule`, so this slice's files stay
 * disjoint from the sibling portal slices that also extend `ClientsModule`. It owns nothing but
 * the read: `ProjectsRepository` (read-only, to resolve a project tenant-scoped before the read,
 * answering 404 rather than 500 for a cross-tenant id) and {@link PortalPeopleProjection}. Both
 * are stateless collections of queries, constructed here rather than imported from `ProjectsModule`
 * for the reason `ClientsModule` gives: importing that dynamic module would build a second copy of
 * it, controllers and all.
 *
 * The database handle is the global `TENANT_DATABASE` (@Global `DatabaseModule`), injected into the
 * controller directly, so this module provides no service and holds no connection.
 */
@Module({})
export class PortalPeopleModule {
  static register(): DynamicModule {
    const projects: Provider = {
      provide: ProjectsRepository,
      useFactory: () => new ProjectsRepository(),
    };

    const people: Provider = {
      provide: PortalPeopleProjection,
      useFactory: () => new PortalPeopleProjection(),
    };

    return {
      module: PortalPeopleModule,
      providers: [projects, people],
      controllers: [PortalPeopleController],
    };
  }
}
