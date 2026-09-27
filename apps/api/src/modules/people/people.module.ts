import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { PeopleDirectoryRepository } from './directory.repository.js';
import { PeopleDirectoryController } from './directory.controller.js';

/**
 * People & capacity — module 14, audit #4.
 *
 * Its own module rather than an addition to `TenancyModule`: the sibling pass-21 slices each
 * register their own module in `app.module.ts` (the shared, integrator-reconciled append point),
 * so this stays file-disjoint from them. The repository is provided by its concrete class — a
 * stateless collection of tenant-scoped queries, no shared token in `tokens.ts` to edit in
 * parallel — and the controller resolves `TENANT_DATABASE` from the global database module for
 * its read. No new table, so nothing to register with the schema, guard, grant or migrator.
 */
@Module({})
export class PeopleModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PeopleDirectoryRepository,
      useValue: new PeopleDirectoryRepository(),
    };

    return {
      module: PeopleModule,
      providers: [repository],
      controllers: [PeopleDirectoryController],
    };
  }
}
