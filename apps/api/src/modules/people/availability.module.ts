import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  MEMBER_AVAILABILITY_REPOSITORY,
  MEMBERSHIPS_REPOSITORY,
} from '../../common/http/tokens.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { MemberAvailabilityRepository } from './availability.repository.js';
import {
  MemberAvailabilityController,
  PersonAvailabilityController,
} from './availability.controller.js';

/**
 * Member availability / out-of-office windows (People module 14, x218) wiring.
 *
 * Two controllers over the same store: the owner-scoped surface (`PersonAvailabilityController`,
 * the caller's own windows) and the team read (`MemberAvailabilityController`, one member's windows).
 * Two stateless repositories under their tokens: the availability repository this slice owns, and the
 * memberships repository the team controller uses to resolve `:membershipId` tenant-scoped before the
 * read. Both are stateless and hold no connection, so a module-local instance is correct even where
 * another module also provides the same token.
 */
@Module({})
export class MemberAvailabilityModule {
  static register(): DynamicModule {
    const availabilityRepository: Provider = {
      provide: MEMBER_AVAILABILITY_REPOSITORY,
      useFactory: () => new MemberAvailabilityRepository(),
    };
    const membershipsRepository: Provider = {
      provide: MEMBERSHIPS_REPOSITORY,
      useFactory: () => new MembershipsRepository(),
    };

    return {
      module: MemberAvailabilityModule,
      providers: [availabilityRepository, membershipsRepository],
      controllers: [PersonAvailabilityController, MemberAvailabilityController],
    };
  }
}
