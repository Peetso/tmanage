import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import type { DynamicModule, OnModuleInit, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { PUBLIC_LINKS_SERVICE } from '../public-links/public-links.controller.js';
import { PUBLIC_LINK_TARGETS } from '../public-links/public-link-targets.js';
import type { PublicLinkTargets } from '../public-links/public-link-targets.js';
import type { PublicLinksService } from '../public-links/public-links.service.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectsService } from '../projects/projects.service.js';
import { repositoryConversionWriter } from './quote-conversion.js';
import { quoteTarget } from './quote-target.js';
import { QUOTES_SERVICE, QuotesController } from './quotes.controller.js';
import { QuotesRepository } from './quotes.repository.js';
import { QuotesService } from './quotes.service.js';

/** Registers the 56-07 `quote` target adapter on the global link registry at start-up. */
@Injectable()
class QuoteTargetRegistrar implements OnModuleInit {
  constructor(
    @Optional()
    @Inject(PUBLIC_LINK_TARGETS)
    private readonly targets: PublicLinkTargets | undefined,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (this.targets !== undefined && this.targets.get('quote') === null) {
      this.targets.register(quoteTarget({ repository: new QuotesRepository(), audit: this.audit }));
    }
  }
}

/**
 * 52-08 wiring. Takes 56-07's global `PUBLIC_LINKS_SERVICE` (send issues the link inside its own
 * transaction) and `PUBLIC_LINK_TARGETS` (the `quote` adapter is registered in `onModuleInit`).
 */
@Module({})
export class QuotesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: QUOTES_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, PUBLIC_LINKS_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService, links: PublicLinksService) =>
        new QuotesService({
          database,
          repository: new QuotesRepository(),
          audit,
          links,
          // The shared project-create path, built as ProjectTemplatesModule builds it.
          projects: new ProjectsService(database, new ProjectsRepository(), audit),
          conversion: repositoryConversionWriter(),
        }),
    };
    return {
      module: QuotesModule,
      providers: [service, QuoteTargetRegistrar],
      controllers: [QuotesController],
    };
  }
}
