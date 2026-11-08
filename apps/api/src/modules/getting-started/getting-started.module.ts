import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { GettingStartedController } from './getting-started.controller.js';

/**
 * 55-11 / 55-22 — the getting-started checklist and Setup health routes. Its own module so it adds
 * nothing to home, onboarding or tenancy; the controller builds its repository itself.
 */
@Module({})
export class GettingStartedModule {
  static register(): DynamicModule {
    return { module: GettingStartedModule, controllers: [GettingStartedController] };
  }
}
