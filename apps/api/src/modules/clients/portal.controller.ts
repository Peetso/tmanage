import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { INVITATIONS_SERVICE, PORTAL_SERVICE } from '../../common/http/tokens.js';
import type { InvitationView, InvitationsService } from '../tenancy/invitations.service.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PortalProjectView, PortalService, PortalWorkItemView } from './portal.service.js';

/**
 * The client portal's read surface — CLIENT-002.
 *
 * A path of its own, `/portal`, rather than a query parameter on the internal endpoints. That
 * is `22-SCREEN-BY-SCREEN` §6's "dedicated route" and it is a security property rather than a
 * routing preference: an internal endpoint that served a client projection when asked nicely
 * is one refactor away from serving the internal record, and the two would share every code
 * path that could get it wrong. These routes reach a different service, which builds different
 * objects, from a query that never selects an internal row.
 *
 * The organization slug is still in the path. A client member's `TenantContext` is resolved
 * from `client_memberships` exactly as an internal member's is from `memberships` — the
 * resolver has read both since TEN-002 — so a client signing in to the wrong slug gets the
 * same refusal anybody else does.
 *
 * `client_projection.read` on every route. It is the capability `12-PERMISSION-MATRIX` §1
 * names in its "View client projection" row, and until CLIENT-002 this codebase did not have
 * it: the one surface every client role exists to read could not be authorized at all.
 */
@Controller('v1/organizations/:orgSlug/portal')
export class PortalController {
  constructor(
    @Inject(PORTAL_SERVICE) private readonly portal: PortalService,
    @Inject(INVITATIONS_SERVICE) private readonly invitations: InvitationsService,
  ) {}

  /**
   * The projects shared with this client organization.
   *
   * `CL-01`'s first viewport is built from this. For an internal caller it answers "what can
   * the client see", which is how anybody checks a publication without asking the client.
   */
  @Get('projects')
  @RequireCapability('client_projection.read')
  async projects(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly projects: readonly PortalProjectView[] }> {
    return { projects: await this.portal.projectsFor(context, principal) };
  }

  /**
   * The client-facing work, optionally in one project.
   *
   * There is no `state` filter, and its absence is deliberate: the projection has no internal
   * state to filter by. `CL-02`'s "My Actions" is `progress === 'waiting_on_you'`, which the
   * client computes from what it was given rather than asking the API to reveal a lifecycle.
   */
  @Get('work-items')
  @RequireCapability('client_projection.read')
  async workItems(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
  ): Promise<{ readonly workItems: readonly PortalWorkItemView[] }> {
    return {
      workItems: await this.portal.workItemsFor(context, principal, {
        ...(projectId ? { projectId } : {}),
      }),
    };
  }

  /**
   * `CL-11 Client member management` — a client admin inviting into **their own** client
   * organization, which is `12-PERMISSION-MATRIX` §2's "Invite client users: within own client
   * org/policy".
   *
   * A route of its own rather than a capability alternative on `POST /invitations`, and the
   * reason is the one that decides the whole design: **the body cannot name a client
   * organization.** It is taken from the principal, so there is no field for a client admin to
   * put a sibling client's id in, and no code path where a check could be forgotten. The
   * internal route keeps `org.manage` and a client principal never reaches it.
   *
   * `InvitationsService` still applies its own check — a client caller must hold
   * `client_member.manage` and the destination must be their own client organization. Two
   * independent places refusing the same thing, which is the intent rather than duplication.
   */
  @Post('client-members')
  @RequireCapability('client_member.manage')
  @HttpCode(201)
  async inviteClientMember(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { readonly email?: unknown; readonly role?: unknown },
  ): Promise<{ readonly invitation: InvitationView; readonly token: string }> {
    const details: { field: string; message: string }[] = [];

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : undefined;
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      details.push({ field: 'email', message: 'must be an email address' });
    }

    const role = typeof body?.role === 'string' && body.role !== '' ? body.role : undefined;
    if (!role) details.push({ field: 'role', message: 'must be a client role' });

    if (details.length > 0 || !email || !role) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.invitations.issue(context, principal, {
      email,
      role,
      // From the principal. There is no such field on the body.
      clientOrganizationId: principal.clientOrganizationId,
    });
  }
}
