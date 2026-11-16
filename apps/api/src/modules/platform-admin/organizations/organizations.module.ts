import { Module } from '@nestjs/common';
import { StorageHoldsHook } from '../../storage-root/storage-holds.js';
import { uuidv7 } from '@tmanage/domain';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { TenantDatabase } from '../../../common/database/tenant-context.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../../common/http/tokens.js';
import { FeatureFlagsRepository } from '../../admin/feature-flags.repository.js';
import { PoliciesRepository } from '../../admin/policies.repository.js';
import type { AuditService } from '../../audit/audit.service.js';
import {
  installPlatformSettingsReader,
  PlatformSettingsReader,
} from '../../billing/platform-settings-reader.js';
import { InvitationsRepository } from '../../tenancy/invitations.repository.js';
import { MembershipsRepository } from '../../tenancy/memberships.repository.js';
import { OffboardingService } from '../../tenancy/offboarding.service.js';
import { OrgSettingsRepository } from '../../tenancy/org-settings.repository.js';
import { OrganizationLogoRepository } from '../../tenancy/organization-logo.repository.js';
import { ProvisioningService } from '../../tenancy/provisioning.service.js';
import { platformAdminCore } from '../platform-admin-core.module.js';
import { PLATFORM_ADMIN_LOOKUP } from '../platform-admin.guard.js';
import type { PlatformAdminRepository } from '../platform-admin.repository.js';
import { PlatformOrganizationLifecycleService } from './lifecycle.service.js';
import {
  PLATFORM_ORG_MEMBERS_SERVICE,
  PlatformOrganizationMembersController,
} from './members.controller.js';
import { PlatformOrganizationMembersService } from './members.service.js';
import { PlatformOrganizationSettingsService } from './org-settings.service.js';
import {
  PLATFORM_ORG_LIFECYCLE_SERVICE,
  PLATFORM_ORG_PROVISIONING,
  PLATFORM_ORG_SETTINGS_SERVICE,
  PLATFORM_ORGANIZATIONS_SERVICE,
  PlatformOrganizationsController,
} from './organizations.controller.js';
import { PlatformOrganizationsRepository } from './organizations.repository.js';
import { PlatformOrganizationsService } from './organizations.service.js';
import { PlatformOrganizationProvisioning } from './provisioning.js';

const PLATFORM_ORGS_REPOSITORY = Symbol.for('tmanage.PlatformOrganizationsRepository');

/**
 * Platform admin · Organizations (listed in `platform-admin.areas.ts`). Also installs the process's
 * `PlatformSettingsReader` (`billingMode()` reads the platform's `billing_mode` through it, cached
 * 30 s), since this module owns the statement that loads a platform setting.
 */
@Module({})
export class PlatformOrganizationsModule {
  static register(): DynamicModule {
    const repository: Provider = {
      provide: PLATFORM_ORGS_REPOSITORY,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => {
        const orgs = new PlatformOrganizationsRepository(database);
        installPlatformSettingsReader(
          new PlatformSettingsReader((key) => orgs.readSetting(key, uuidv7())),
        );
        return orgs;
      },
    };
    const service: Provider = {
      provide: PLATFORM_ORGANIZATIONS_SERVICE,
      inject: [PLATFORM_ADMIN_LOOKUP, PLATFORM_ORGS_REPOSITORY],
      useFactory: (lookup: PlatformAdminRepository, orgs: PlatformOrganizationsRepository) =>
        new PlatformOrganizationsService(lookup, orgs),
    };
    const lifecycle: Provider = {
      provide: PLATFORM_ORG_LIFECYCLE_SERVICE,
      inject: [PLATFORM_ORGANIZATIONS_SERVICE, PLATFORM_ORGS_REPOSITORY, AUDIT_SERVICE],
      useFactory: (
        organizations: PlatformOrganizationsService,
        orgs: PlatformOrganizationsRepository,
        audit: AuditService,
      ) =>
        new PlatformOrganizationLifecycleService(
          organizations,
          orgs,
          new MembershipsRepository(),
          audit,
        ),
    };
    const settings: Provider = {
      provide: PLATFORM_ORG_SETTINGS_SERVICE,
      inject: [PLATFORM_ORGANIZATIONS_SERVICE, PLATFORM_ORGS_REPOSITORY, TENANT_DATABASE],
      useFactory: (
        organizations: PlatformOrganizationsService,
        orgs: PlatformOrganizationsRepository,
        database: TenantDatabase,
      ) =>
        new PlatformOrganizationSettingsService(
          organizations,
          orgs,
          database,
          new OrgSettingsRepository(),
          new PoliciesRepository(),
          new FeatureFlagsRepository(),
          new OrganizationLogoRepository(),
        ),
    };
    const provisioning: Provider = {
      provide: PLATFORM_ORG_PROVISIONING,
      inject: [
        PLATFORM_ORGANIZATIONS_SERVICE,
        PLATFORM_ORGS_REPOSITORY,
        TENANT_DATABASE,
        AUDIT_SERVICE,
      ],
      useFactory: (
        organizations: PlatformOrganizationsService,
        orgs: PlatformOrganizationsRepository,
        database: TenantDatabase,
        audit: AuditService,
      ) =>
        new PlatformOrganizationProvisioning(
          organizations,
          orgs,
          new ProvisioningService(database, audit),
        ),
    };
    const members: Provider = {
      provide: PLATFORM_ORG_MEMBERS_SERVICE,
      inject: [
        PLATFORM_ORGANIZATIONS_SERVICE,
        PLATFORM_ORGS_REPOSITORY,
        TENANT_DATABASE,
        AUDIT_SERVICE,
      ],
      useFactory: (
        organizations: PlatformOrganizationsService,
        orgs: PlatformOrganizationsRepository,
        database: TenantDatabase,
        audit: AuditService,
      ) => {
        const memberships = new MembershipsRepository();
        return new PlatformOrganizationMembersService(
          organizations,
          orgs,
          memberships,
          new InvitationsRepository(),
          new OffboardingService(
            database,
            memberships,
            audit,
            undefined,
            undefined,
            undefined,
            undefined,
            new StorageHoldsHook(),
          ),
          audit,
        );
      },
    };
    return {
      module: PlatformOrganizationsModule,
      imports: [platformAdminCore()],
      providers: [repository, service, lifecycle, settings, provisioning, members],
      controllers: [PlatformOrganizationsController, PlatformOrganizationMembersController],
    };
  }
}
