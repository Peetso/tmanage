import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  MEMBERSHIP_RESOLVER,
  ORGANIZATION_DIRECTORY_REPOSITORY,
  PRINCIPAL_REPOSITORY,
  PROVISIONING_SERVICE,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { MembershipResolver } from './membership-resolver.repository.js';
import { OrganizationDirectoryRepository } from './organization-directory.repository.js';
import { OrganizationsController } from './organizations.controller.js';
import { PrincipalRepository } from './principal.repository.js';
import { ProvisioningService } from './provisioning.service.js';

/**
 * Spec §3 steps 2 to 4, made injectable — plus, since TEN-001's second half landed, the two
 * routes that come before them.
 *
 * The comment here used to read "No controllers. Nothing here is an endpoint — organization
 * creation is still unimplemented (an unscoped write; see the named gaps under TEN-001)".
 * `OrganizationsController` is now that endpoint, and the parenthesis turned out to be the
 * wrong diagnosis: provisioning is not an unscoped write. It generates the organization's id
 * first and runs inside a context bound to it, so every statement is scoped to an
 * organization nothing else references yet. `ProvisioningService` carries the argument.
 *
 * The resolver and the principal repository are still not endpoints. They exist so
 * `TenantContextGuard` can reach them.
 */
@Module({})
export class TenancyModule {
  static register(): DynamicModule {
    const resolver: Provider = {
      provide: MEMBERSHIP_RESOLVER,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new MembershipResolver(database),
    };
    const principals: Provider = {
      provide: PRINCIPAL_REPOSITORY,
      useFactory: () => new PrincipalRepository(),
    };

    const directory: Provider = {
      provide: ORGANIZATION_DIRECTORY_REPOSITORY,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new OrganizationDirectoryRepository(database),
    };
    const provisioning: Provider = {
      provide: PROVISIONING_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, audit: AuditService) =>
        new ProvisioningService(database, audit),
    };

    return {
      module: TenancyModule,
      providers: [resolver, principals, directory, provisioning],
      exports: [resolver, principals, directory, provisioning],
      controllers: [OrganizationsController],
    };
  }
}
