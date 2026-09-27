import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { PUBLIC_SITE_STATUS_REPOSITORY } from '../../common/http/tokens.js';
import { StatusRepository } from './status.repository.js';
import { PublicSiteStatusController } from './status.controller.js';

/**
 * Public & trust site (x159) — the public status page.
 *
 * One `@Public()` controller over a stateless repository. Unlike every tenant module here it wires
 * no service and depends on no `ProjectsRepository`: the read is global (`incidents`, 0060), asks for
 * no capability, and resolves no tenant, so the controller reads the global `TenantDatabase` and the
 * repository directly. It touches none of the tenant modules' files.
 */
@Module({})
export class PublicSiteModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PUBLIC_SITE_STATUS_REPOSITORY,
      useFactory: () => new StatusRepository(),
    };

    return {
      module: PublicSiteModule,
      providers: [repository],
      controllers: [PublicSiteStatusController],
    };
  }
}
