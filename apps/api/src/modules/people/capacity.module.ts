import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { MEMBERSHIPS_REPOSITORY, PERSON_CAPACITY_REPOSITORY } from '../../common/http/tokens.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { PersonCapacityRepository } from './capacity.repository.js';
import { PersonCapacityController } from './capacity.controller.js';

/**
 * People capacity (module 14, x170) wiring.
 *
 * Two stateless repositories under their tokens: the capacity repository this slice owns, and the
 * memberships repository the controller uses to resolve `:membershipId` tenant-scoped before any
 * write. Both are stateless, so the memberships repository is provided in this module's own scope
 * under its shared token rather than imported across a module boundary.
 */
@Module({})
export class PersonCapacityModule {
  static register(): DynamicModule {
    const capacityRepository: Provider = {
      provide: PERSON_CAPACITY_REPOSITORY,
      useFactory: () => new PersonCapacityRepository(),
    };

    const membershipsRepository: Provider = {
      provide: MEMBERSHIPS_REPOSITORY,
      useFactory: () => new MembershipsRepository(),
    };

    return {
      module: PersonCapacityModule,
      providers: [capacityRepository, membershipsRepository],
      controllers: [PersonCapacityController],
    };
  }
}
