import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { OnboardingWizardController } from './onboarding-wizard.controller.js';

/**
 * 55-01 / 55-01a / 55-03 — the onboarding wizard's state routes. Its own module so it adds nothing
 * to the tenancy or home modules; the controller builds its settings repository itself.
 */
@Module({})
export class OnboardingModule {
  static register(): DynamicModule {
    return { module: OnboardingModule, controllers: [OnboardingWizardController] };
  }
}
