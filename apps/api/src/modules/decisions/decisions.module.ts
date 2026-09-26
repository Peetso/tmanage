import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  DECISIONS_REPOSITORY,
  DECISIONS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { DecisionsRepository } from './decisions.repository.js';
import { DecisionSupersessionsRepository } from './decision-supersessions.repository.js';
import { DecisionLocksRepository } from './decision-lock.repository.js';
import { DecisionsService } from './decisions.service.js';
import { DecisionsController } from './decisions.controller.js';
import { DecisionLockController } from './decision-lock.controller.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { MeetingsRepository } from '../calendar/meetings.repository.js';

/**
 * DEC-01 (x113). The decisions module — the cross-meeting decision register (author + list).
 *
 * Same shape as `CalendarModule`/`DocsModule` — a stateless repository under its token, a service
 * that takes the tenant database and the repository, and one controller. The service takes two more
 * read-only, stateless repositories, constructed here as `CalendarModule` constructs its own: a
 * `ProjectsRepository` to resolve a named project inside the tenant before a write (so an unknown or
 * cross-tenant `projectId` is a 404, not a 500), and a `MeetingsRepository` to do the same for the
 * optional `meetingId`.
 */
@Module({})
export class DecisionsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: DECISIONS_REPOSITORY,
      useFactory: () => new DecisionsRepository(),
    };
    const service: Provider = {
      provide: DECISIONS_SERVICE,
      inject: [TENANT_DATABASE, DECISIONS_REPOSITORY],
      useFactory: (database: TenantDatabase, decisions: DecisionsRepository) =>
        new DecisionsService(
          database,
          decisions,
          new ProjectsRepository(),
          new MeetingsRepository(),
          new DecisionSupersessionsRepository(),
          new DecisionLocksRepository(),
        ),
    };

    return {
      module: DecisionsModule,
      providers: [repository, service],
      exports: [service],
      controllers: [DecisionsController, DecisionLockController],
    };
  }
}
