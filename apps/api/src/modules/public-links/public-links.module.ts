import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Mailer } from '@tmanage/mail';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { AUDIT_SERVICE, MAILER, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import { deliverableVersionTarget } from './deliverable-version-target.repository.js';
import { PublicLinkSecrets } from './public-link-secrets.js';
import { PUBLIC_LINK_TARGETS, PublicLinkTargets } from './public-link-targets.js';
import {
  PUBLIC_LINKS_SERVICE,
  PublicLinkAccessController,
  PublicLinksController,
} from './public-links.controller.js';
import { findLinkByTokenHash } from './public-links.repository.js';
import { PublicLinksService } from './public-links.service.js';

export interface PublicLinksModuleOptions {
  /** `PUBLIC_LINK_PEPPER` (56-02); the same fallback `RateLimitsModule` uses when it is unset. */
  readonly pepper: string;
}

/**
 * 56-07 wiring. Global so a consumer module injects {@link PUBLIC_LINK_TARGETS} to register its
 * target adapter (52-08: `targets.register(quoteTarget)` in `onModuleInit`) and
 * {@link PUBLIC_LINKS_SERVICE} to issue a link inside its own command (`createInTransaction`).
 */
@Module({})
export class PublicLinksModule {
  static register(options: PublicLinksModuleOptions): DynamicModule {
    const targets: Provider = {
      provide: PUBLIC_LINK_TARGETS,
      useFactory: () => {
        const registry = new PublicLinkTargets();
        registry.register(deliverableVersionTarget);
        return registry;
      },
    };
    const service: Provider = {
      provide: PUBLIC_LINKS_SERVICE,
      inject: [
        TENANT_DATABASE,
        PUBLIC_LINK_TARGETS,
        AUDIT_SERVICE,
        { token: MAILER, optional: true },
      ],
      useFactory: (
        database: TenantDatabase,
        registry: PublicLinkTargets,
        audit: AuditService,
        mailer: Mailer | null | undefined,
      ) =>
        new PublicLinksService({
          database,
          lookup: (hash, correlationId) => findLinkByTokenHash(database, hash, correlationId),
          targets: registry,
          secrets: new PublicLinkSecrets(options.pepper),
          audit,
          mailer: mailer ?? null,
        }),
    };
    return {
      module: PublicLinksModule,
      global: true,
      providers: [targets, service],
      controllers: [PublicLinksController, PublicLinkAccessController],
      exports: [PUBLIC_LINK_TARGETS, PUBLIC_LINKS_SERVICE],
    };
  }
}
