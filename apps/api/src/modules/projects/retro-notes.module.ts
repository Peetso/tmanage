import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  PROJECT_RETRO_NOTES_REPOSITORY,
  PROJECT_RETRO_NOTES_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectRetroNotesRepository } from './retro-notes.repository.js';
import { ProjectRetroNotesService } from './retro-notes.service.js';
import { ProjectRetroNotesController } from './retro-notes.controller.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';

/**
 * PROJ / module 8 (x311). The retrospective-notes module — a project's categorised reflection log
 * (capture, list grouped by category, delete).
 *
 * Same shape as `ProjectStatusUpdatesModule`: a stateless repository under its token, a service that
 * takes the tenant database and the repository, and one controller. The service takes two more
 * read-only, stateless repositories: `ProjectsRepository` to resolve a named project inside the
 * tenant before a write (unknown/cross-tenant ⇒ 404, not a foreign-key 500), and
 * `ProjectMilestonesRepository` to resolve an optional milestone reference tenant-scoped (unknown ⇒
 * 400).
 */
@Module({})
export class ProjectRetroNotesModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PROJECT_RETRO_NOTES_REPOSITORY,
      useFactory: () => new ProjectRetroNotesRepository(),
    };
    const service: Provider = {
      provide: PROJECT_RETRO_NOTES_SERVICE,
      inject: [TENANT_DATABASE, PROJECT_RETRO_NOTES_REPOSITORY],
      useFactory: (database: TenantDatabase, notes: ProjectRetroNotesRepository) =>
        new ProjectRetroNotesService(
          database,
          notes,
          new ProjectsRepository(),
          new ProjectMilestonesRepository(),
        ),
    };

    return {
      module: ProjectRetroNotesModule,
      providers: [repository, service],
      exports: [service],
      controllers: [ProjectRetroNotesController],
    };
  }
}
