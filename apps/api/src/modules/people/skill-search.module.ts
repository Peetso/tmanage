import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { PERSON_SKILL_SEARCH_REPOSITORY } from '../../common/http/tokens.js';
import { PersonSkillSearchRepository } from './skill-search.repository.js';
import { SkillSearchController } from './skill-search.controller.js';

/**
 * Skill directory search (module 14, x194) wiring.
 *
 * A stateless read-only repository under its token; the controller injects it alongside the tenant
 * database. Registered additively in `app.module.ts` beside the other People slices — its controller
 * mounts under `…/people/skills/search`, a distinct literal path from x172's
 * `…/people/:membershipId/skills`, disjoint from every other module's files.
 */
@Module({})
export class SkillSearchModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PERSON_SKILL_SEARCH_REPOSITORY,
      useFactory: () => new PersonSkillSearchRepository(),
    };

    return {
      module: SkillSearchModule,
      providers: [repository],
      controllers: [SkillSearchController],
    };
  }
}
