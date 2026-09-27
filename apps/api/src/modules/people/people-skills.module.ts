import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { PERSON_SKILLS_REPOSITORY } from '../../common/http/tokens.js';
import { PersonSkillsRepository } from './skills.repository.js';
import { PersonSkillsController } from './skills.controller.js';

/**
 * People member skills (module 14, x172) wiring.
 *
 * A stateless repository under its token; the controller injects it alongside the tenant database.
 * The module is registered additively in `app.module.ts` beside the other People slices — its
 * controller mounts under `…/people/:membershipId/skills`, disjoint from every other module's files.
 */
@Module({})
export class PeopleSkillsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PERSON_SKILLS_REPOSITORY,
      useFactory: () => new PersonSkillsRepository(),
    };

    return {
      module: PeopleSkillsModule,
      providers: [repository],
      controllers: [PersonSkillsController],
    };
  }
}
