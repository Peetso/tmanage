import { Module } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import {
  AUDIT_SERVICE,
  INVITATION_MAILER,
  INVITATIONS_REPOSITORY,
  INVITATIONS_SERVICE,
  MEMBERSHIP_RESOLVER,
  MEMBERSHIPS_REPOSITORY,
  OFFBOARDING_SERVICE,
  ORGANIZATION_DIRECTORY_REPOSITORY,
  PRINCIPAL_REPOSITORY,
  PROVISIONING_SERVICE,
  TENANT_DATABASE,
  WORKSPACES_REPOSITORY,
} from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { InvitationMailer } from '../../common/email/invitation-mailer.js';
import type { AuditService } from '../audit/audit.service.js';
import { ClientMembershipsRepository } from '../clients/client-memberships.repository.js';
import { InvitationsController, InvitationAcceptanceController } from './invitations.controller.js';
import { InvitationsRepository } from './invitations.repository.js';
import { InvitationsService } from './invitations.service.js';
import { MembersController } from './members.controller.js';
import { MembershipsRepository } from './memberships.repository.js';
import { OffboardingController } from './offboarding.controller.js';
import { OffboardingService } from './offboarding.service.js';
import { MembershipResolver } from './membership-resolver.repository.js';
import { OrganizationDirectoryRepository } from './organization-directory.repository.js';
import { OrganizationsController } from './organizations.controller.js';
import { PrincipalRepository } from './principal.repository.js';
import { ProvisioningService } from './provisioning.service.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesRepository } from './workspaces.repository.js';

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

    const workspaces: Provider = {
      provide: WORKSPACES_REPOSITORY,
      useFactory: () => new WorkspacesRepository(),
    };

    // Registered rather than constructed at the call site, unlike the two the invitations
    // service builds for itself: `MembersController` is a controller, and Nest resolves a
    // controller's constructor from the container.
    const membershipsRepository: Provider = {
      provide: MEMBERSHIPS_REPOSITORY,
      useFactory: () => new MembershipsRepository(),
    };

    const invitationsRepository: Provider = {
      provide: INVITATIONS_REPOSITORY,
      useFactory: () => new InvitationsRepository(),
    };

    // ADM-12/13 (x121). The offboarding service reuses the memberships repository the module
    // already provides and the audit service `ProvisioningService` already depends on; its two
    // read-only repositories (project memberships, work items) are stateless and constructed by
    // the service itself, the same way `MeetingsService` owns the handles it only reads through.
    const offboardingService: Provider = {
      provide: OFFBOARDING_SERVICE,
      inject: [TENANT_DATABASE, MEMBERSHIPS_REPOSITORY, AUDIT_SERVICE],
      useFactory: (database: TenantDatabase, memberships: MembershipsRepository, audit: AuditService) =>
        new OffboardingService(database, memberships, audit),
    };

    const invitationsService: Provider = {
      provide: INVITATIONS_SERVICE,
      inject: [TENANT_DATABASE, INVITATIONS_REPOSITORY, AUDIT_SERVICE, INVITATION_MAILER],
      useFactory: (
        database: TenantDatabase,
        invitations: InvitationsRepository,
        audit: AuditService,
        invitationMail: InvitationMailer,
      ) =>
        new InvitationsService(
          database,
          invitations,
          // Both membership repositories are constructed here rather than injected, for the
          // reason `ClientsModule` constructs its own `ProjectsRepository`: a repository is a
          // stateless collection of queries with no injected dependencies, and reaching for
          // another module’s provider would mean registering that dynamic module twice.
          new MembershipsRepository(),
          new ClientMembershipsRepository(),
          audit,
          invitationMail,
        ),
    };

    return {
      module: TenancyModule,
      providers: [
        resolver,
        principals,
        directory,
        provisioning,
        workspaces,
        membershipsRepository,
        invitationsRepository,
        invitationsService,
        offboardingService,
      ],
      exports: [
        resolver,
        principals,
        directory,
        provisioning,
        workspaces,
        membershipsRepository,
        invitationsService,
      ],
      controllers: [
        OrganizationsController,
        WorkspacesController,
        MembersController,
        OffboardingController,
        InvitationsController,
        // The route with no tenant. Its own controller so that `@NoTenant()` sits on a class
        // whose whole purpose is the pre-membership path, rather than on one method of a
        // controller where every other route is tenant-scoped.
        InvitationAcceptanceController,
      ],
    };
  }
}
