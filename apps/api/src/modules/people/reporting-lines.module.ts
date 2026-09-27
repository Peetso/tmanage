import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { MEMBERSHIPS_REPOSITORY, REPORTING_LINES_REPOSITORY } from '../../common/http/tokens.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { ReportingLinesRepository } from './reporting-lines.repository.js';
import { ReportingLinesController } from './reporting-lines.controller.js';

/**
 * People reporting lines / org chart (module 14, x217) wiring.
 *
 * Two stateless repositories under their tokens: the reporting-lines repository this slice owns, and
 * the memberships repository the controller uses to resolve the member and the manager tenant-scoped
 * before any write. Both are stateless and hold no connection, so a module-local instance under the
 * shared token is correct even where another module also provides it.
 */
@Module({})
export class ReportingLinesModule {
  static register(): DynamicModule {
    const reportingLinesRepository: Provider = {
      provide: REPORTING_LINES_REPOSITORY,
      useFactory: () => new ReportingLinesRepository(),
    };

    const membershipsRepository: Provider = {
      provide: MEMBERSHIPS_REPOSITORY,
      useFactory: () => new MembershipsRepository(),
    };

    return {
      module: ReportingLinesModule,
      providers: [reportingLinesRepository, membershipsRepository],
      controllers: [ReportingLinesController],
    };
  }
}
