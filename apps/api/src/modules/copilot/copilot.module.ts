import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { CopilotController } from './copilot.controller.js';

/**
 * The AI copilot shell's wiring — a self-contained module registered from `app.module.ts` (the
 * shared append point), file-disjoint from the search slices. The controller constructs its own
 * {@link CopilotService} over the injected tenant database and a feature-flag repository, and the
 * service owns the provider seam, so there is no provider to declare here: the offline stub is the
 * default, and a future real provider is a change inside the service, not this module.
 */
@Module({})
export class CopilotModule {
  static register(): DynamicModule {
    return {
      module: CopilotModule,
      controllers: [CopilotController],
    };
  }
}
