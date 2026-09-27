import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  WORKFLOW_RUNS_REPOSITORY,
  WORKFLOW_RUN_HISTORY_REPOSITORY,
  WORKFLOW_RUN_SERVICE,
  WORKFLOW_TEMPLATES_REPOSITORY,
} from '../../common/http/tokens.js';
import { WorkflowTemplatesRepository } from './templates.repository.js';
import { WorkflowTemplatesController } from './templates.controller.js';
import { WorkflowRunsRepository } from './run.repository.js';
import { WorkflowRunService } from './run.service.js';
import { WorkflowRunController } from './run.controller.js';
import { WorkflowRunHistoryRepository } from './history.repository.js';
import { WorkflowRunHistoryController } from './history.controller.js';
import { WorkflowTemplateEditController } from './template-edit.controller.js';

/**
 * Automations & integrations (module 17). Workflow templates — define, list (x162), edit (x189) —
 * execution — run a template, record the run (x163) — and run history — list runs, read one (x164).
 *
 * The same shape as the org-scoped read/write modules: stateless repositories under their tokens and
 * controllers that resolve `TENANT_DATABASE` and the repositories. It reuses `org.manage`, so it adds
 * nothing to the capability files. The run service is a pure, dependency-free deterministic executor
 * with no external egress; the history repository is read-only over the runs x163 writes.
 */
@Module({})
export class AutomationsModule {
  static register(): DynamicModule {
    const templatesRepository: Provider = {
      provide: WORKFLOW_TEMPLATES_REPOSITORY,
      useFactory: () => new WorkflowTemplatesRepository(),
    };
    const runsRepository: Provider = {
      provide: WORKFLOW_RUNS_REPOSITORY,
      useFactory: () => new WorkflowRunsRepository(),
    };
    const runService: Provider = {
      provide: WORKFLOW_RUN_SERVICE,
      useClass: WorkflowRunService,
    };
    const runHistoryRepository: Provider = {
      provide: WORKFLOW_RUN_HISTORY_REPOSITORY,
      useFactory: () => new WorkflowRunHistoryRepository(),
    };

    return {
      module: AutomationsModule,
      providers: [templatesRepository, runsRepository, runService, runHistoryRepository],
      controllers: [
        WorkflowTemplatesController,
        WorkflowTemplateEditController,
        WorkflowRunController,
        WorkflowRunHistoryController,
      ],
    };
  }
}
