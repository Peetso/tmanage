import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  DECISION_WORK_LINKS_REPOSITORY,
  DECISION_WORK_LINKS_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { DecisionWorkLinksRepository } from './decision-work-links.repository.js';
import { DecisionWorkLinksService } from './decision-work-links.service.js';
import { DecisionWorkLinksController } from './decision-work-links.controller.js';
import { DecisionsRepository } from './decisions.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';

/**
 * DEC / module 12 (x149). The decision→work-links module — link, list and unlink the work a decision
 * set in motion.
 *
 * Same shape as `ObjectiveWorkLinksModule` — a stateless repository under its token, a service that
 * takes the tenant database and the repository. The service takes two more read-only, stateless
 * repositories constructed here: a `DecisionsRepository` to resolve the decision (and its project)
 * tenant-scoped before a write, and a `WorkItemsRepository` to resolve the work item in the same
 * project — so an unknown or cross-tenant id is a 404, not a foreign-key 500.
 */
@Module({})
export class DecisionWorkLinksModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: DECISION_WORK_LINKS_REPOSITORY,
      useFactory: () => new DecisionWorkLinksRepository(),
    };
    const service: Provider = {
      provide: DECISION_WORK_LINKS_SERVICE,
      inject: [TENANT_DATABASE, DECISION_WORK_LINKS_REPOSITORY],
      useFactory: (database: TenantDatabase, links: DecisionWorkLinksRepository) =>
        new DecisionWorkLinksService(
          database,
          links,
          new DecisionsRepository(),
          new WorkItemsRepository(),
        ),
    };

    return {
      module: DecisionWorkLinksModule,
      providers: [repository, service],
      exports: [service],
      controllers: [DecisionWorkLinksController],
    };
  }
}
