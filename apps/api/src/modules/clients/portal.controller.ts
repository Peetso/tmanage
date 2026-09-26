import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import {
  CLIENT_REQUESTS_SERVICE,
  INVITATIONS_SERVICE,
  PORTAL_SERVICE,
} from '../../common/http/tokens.js';
import type { InvitationView, InvitationsService } from '../tenancy/invitations.service.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  PortalDeliverableFileView,
  PortalDeliverableView,
  PortalProjectView,
  PortalService,
  PortalUpdateView,
  PortalWorkItemView,
} from './portal.service.js';
import type {
  ClientRequestClientView,
  ClientRequestsService,
} from '../requests/client-requests.service.js';
import { parseSubmitBody, requiredVersion } from '../requests/client-request-input.js';

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
    @Inject(CLIENT_REQUESTS_SERVICE) private readonly requests: ClientRequestsService,
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
   * The published deliverables the client may see in one project — x114, `CL-03`.
   *
   * `projectId` is in the path and resolved **tenant + client-membership scoped before** the
   * projection is read (FAST-PROTOCOL Known trap): an unknown or cross-tenant id is a `404` from
   * the service's `mayRead`, never a 500. Every field returned is from the x97 client-projection
   * allowlist; an unpublished deliverable has no projection and so does not appear.
   */
  @Get('projects/:projectId/deliverables')
  @RequireCapability('client_projection.read')
  async deliverables(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly deliverables: readonly PortalDeliverableView[] }> {
    return { deliverables: await this.portal.deliverablesFor(context, principal, projectId) };
  }

  /**
   * The client-visible files attached to one client-visible deliverable — x114, `CL-03`.
   *
   * `deliverableId` is resolved tenant-scoped first (its published projection), then its project
   * is run through the client relation check; a deliverable a client cannot see — unknown,
   * cross-tenant, unpublished, or another client's — is a `404`. Only `ready`, client-audience
   * files scoped to the caller's own client organization are returned; the bytes are a later
   * ticket (the download proxy).
   */
  @Get('deliverables/:deliverableId/files')
  @RequireCapability('client_projection.read')
  async deliverableFiles(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
  ): Promise<{ readonly files: readonly PortalDeliverableFileView[] }> {
    return { files: await this.portal.filesForDeliverable(context, principal, deliverableId) };
  }

  /**
   * `CL-03` — the published updates timeline for one of this client's projects (CLIENT-003).
   *
   * The project is named in the path. {@link PortalService.updatesFor} resolves it
   * relation-scoped **before** the read (the Known-trap order) and returns **404** — not an empty
   * list and not 403 — for an unknown, cross-tenant or sibling-client id, so this route never
   * doubles as a probe for which projects exist. Only `published = 1` rows come back, and the
   * view carries no staff identity.
   */
  @Get('projects/:projectId/updates')
  @RequireCapability('client_projection.read')
  async projectUpdates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly updates: readonly PortalUpdateView[] }> {
    return { updates: await this.portal.updatesFor(context, principal, projectId) };
  }

  /**
   * `CL-06 New request` — US-B01, and the first write a client principal has ever been able to
   * make.
   *
   * `client_request.submit` is the one capability every client role holds, which is why this is
   * the route that turns the portal from something a client reads into something they use.
   *
   * **The body cannot name a client organization.** It is taken from the principal, exactly as
   * on `POST client-members` below and for the same reason: there is no field for a client to
   * put a sibling client's id in, so there is no code path where the check could be forgotten.
   *
   * **The body cannot name files either**, and that absence is a gap rather than a decision.
   * CL-06 lists files and US-B01 requires them scanned; `FILE-001` has not shipped and nothing
   * in this system scans anything. A field accepting ids of files nobody had checked would be
   * worse than the omission — see `client-request-input.ts`.
   */
  @Post('requests')
  @RequireCapability('client_request.submit')
  @HttpCode(201)
  async submitRequest(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
  ): Promise<ClientRequestClientView> {
    return this.requests.submit(context, principal, parseSubmitBody(body ?? {}));
  }

  /**
   * `CL-02 My Actions` and `CL-06`'s list — one client organization's own requests.
   *
   * The client-organization filter is a **query predicate** built from the principal, so a
   * sibling client's rows are never selected. There is no `clientOrganizationId` parameter, for
   * the same reason there is no such field on the body above.
   */
  @Get('requests')
  @RequireCapability('client_request.submit')
  async listRequests(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
  ): Promise<{ readonly requests: readonly ClientRequestClientView[] }> {
    return {
      requests: await this.requests.listForClient(context, principal, {
        ...(projectId ? { projectId } : {}),
      }),
    };
  }

  /** `CL-06 request detail` — the state, and the client-safe reason that goes with it. */
  @Get('requests/:clientRequestId')
  @RequireCapability('client_request.submit')
  async getRequest(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
  ): Promise<ClientRequestClientView> {
    return this.requests.getForClient(context, principal, clientRequestId);
  }

  /**
   * `23-ERD` §6's "Client may withdraw before delivered" — the only move a client has.
   *
   * A route naming its one destination rather than a general transitions endpoint with a `to`
   * field. A client body that could name a state would be a body that could name `accepted`,
   * and the refusal would then rest on a check rather than on there being nothing to check.
   * The state machine still decides whether withdrawal is legal from where the request actually
   * is — a delivered request cannot be withdrawn, and that comes from §6 rather than from here.
   */
  @Post('requests/:clientRequestId/withdrawal')
  @RequireCapability('client_request.submit')
  @HttpCode(200)
  async withdrawRequest(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Body() body: { readonly version?: unknown },
  ): Promise<ClientRequestClientView> {
    const details: { field: string; message: string }[] = [];
    const version = requiredVersion(body?.version, details);
    if (details.length > 0 || version === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.requests.withdraw(context, principal, clientRequestId, version);
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
