import { Controller, Get, HttpCode, Inject, Module, Optional, Param, Post } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InvitationManagementService } from './invitation-management.service.js';

/**
 * Admin pending-invitation management (Administration module 18, x328; 38-MODULE-MAP §Administration
 * member lifecycle, 22-SCREEN §Administration members). Two routes over the **existing** invitations
 * table (TEN-003), behind `org.manage` — the same org-administration capability the sibling admin
 * reads sit behind, so this needs no new capability, no `capabilities.ts` edit, and no migration:
 *
 * - `GET  …/admin/invitations`            — the tenant's pending invitations (metadata only).
 * - `POST …/admin/invitations/:id/revoke` — withdraw one pending invitation (204).
 *
 * It is a separate controller and module, file-disjoint from the tenancy invitation-issuance slices,
 * so the administration surface lands in parallel. It resends nothing — resending an invitation email
 * needs the email provider (Needs-Peter) — a revoke is a local status change only.
 *
 * The safety is the service's: the revoke resolves the invitation by `(tenant, id)` BEFORE it
 * authorizes (a cross-tenant id is a 404 with no write), then authorizes the caller's `org.manage`
 * (403), then transitions pending → revoked idempotently (accepted/expired → 409, already-revoked →
 * 204). No token or secret value is ever in a response — the list is metadata only.
 */

/**
 * The pending-invitations list shape — CONTRACT paired `Exact` with `AdminInvitationsView` in
 * `apps/web/src/lib/api/admin-invitations.ts`. Metadata only: the invited address, the role offered,
 * who invited them and their name/email, the expiry, when it was created, and whether a still-pending
 * invitation has already passed its expiry (the expired chip). The token hash is never projected.
 */
export interface AdminInvitationsView {
  readonly invitations: readonly {
    readonly id: string;
    readonly email: string;
    readonly role: string;
    readonly invitedByUserId: string;
    readonly invitedByName: string;
    readonly invitedByEmail: string;
    readonly expiresAt: string;
    readonly createdAt: string;
    readonly isExpired: boolean;
    /** R38 G4: the projects the invitation is tagged with (shared or joined on acceptance). */
    readonly projects: readonly { readonly id: string; readonly name: string }[];
  }[];
}

@Controller('v1/organizations/:orgSlug/admin/invitations')
export class AdminInvitationManagementController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Optional()
    @Inject(InvitationManagementService)
    private readonly service: InvitationManagementService = new InvitationManagementService(),
  ) {}

  /** The tenant's pending invitations (200). Authorized `org.manage`; metadata only, no token. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AdminInvitationsView> {
    const now = new Date();
    return this.database.read(context, (runner) =>
      this.service.list(runner, context, principal, now),
    );
  }

  /**
   * Revoke one pending invitation (204). The service resolves by `(tenant, id)` before authorize (404),
   * authorizes `org.manage` (403), and transitions idempotently (accepted/expired → 409, already-revoked
   * → 204). Runs inside one tenant-scoped transaction.
   */
  @Post(':id/revoke')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async revoke(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    await this.database.transaction(context, (tx) =>
      this.service.revoke(tx, context, principal, id),
    );
  }
}

/**
 * x328's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * file-disjoint from the tenancy and other administration slices. The service is stateless (tenant-scoped
 * reads and one state transition), constructed here; the controller injects it and the `@Global`
 * `TENANT_DATABASE`.
 */
@Module({})
export class AdminInvitationManagementModule {
  static register(): DynamicModule {
    return {
      module: AdminInvitationManagementModule,
      providers: [
        {
          provide: InvitationManagementService,
          useFactory: () => new InvitationManagementService(),
        },
      ],
      controllers: [AdminInvitationManagementController],
    };
  }
}
