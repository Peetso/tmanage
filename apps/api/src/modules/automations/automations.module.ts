import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { WORKFLOW_TEMPLATES_REPOSITORY } from '../../common/http/tokens.js';
import { WorkflowTemplatesRepository } from './templates.repository.js';
import { WorkflowTemplatesController } from './templates.controller.js';

/**
 * Automations & integrations (module 17, x162). The automations module — workflow templates
 * (define, list).
 *
 * The same shape as the org-scoped read/write modules (e.g. `WorkFormsModule`'s repository wiring): a
 * stateless repository under its token and one controller that resolves `TENANT_DATABASE` and the
 * repository. It reuses `org.manage`, so it adds nothing to the capability files; execution/runs are
 * a later module (x163).
 */
@Module({})
export class AutomationsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: WORKFLOW_TEMPLATES_REPOSITORY,
      useFactory: () => new WorkflowTemplatesRepository(),
    };

    return {
      module: AutomationsModule,
      providers: [repository],
      controllers: [WorkflowTemplatesController],
    };
  }
}
