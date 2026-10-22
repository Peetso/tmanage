import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CLIENTS_SERVICE, INVITATIONS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { isClientRole } from './clients.service.js';
import type {
  ClientMembershipView,
  ClientOrganizationOption,
  ClientOrganizationView,
  ClientsService,
  ProjectClientView,
} from './clients.service.js';
import type { ClientMembershipStatus } from './client-memberships.repository.js';
import type { InvitationStatus } from '../tenancy/invitations.repository.js';
import type { InvitationView, InvitationsService } from '../tenancy/invitations.service.js';

/**
 * CLIENT-001's HTTP surface.
 *
 * Three groups of routes and one rule that runs through all of them: **the concurrency token
 * is `updatedAt`, and it is required on every write that changes an existing row.**
 * `client_organizations` and `client_memberships` have no `version` column — the same position
 * `projects` is in — so the timestamp is the token, sent as the ISO 8601 string the caller read
 * and compared as an instant.
 *
 * The capability decorators are the coarse gate: `CapabilityGuard` refuses a caller whose role
 * does not hold the capability at all, before any handler runs. The *scoped* rule — a client
 * admin manages their own client organization and nobody else's — is the service's, because it
 * needs the row to decide and a guard does not have one.
 *
 * ## What is not here
 *
 * No route deletes a client organization or a membership. Both are lifecycle states —
 * `archived_at` and `status` — for the reason `04-SECURITY-PRIVACY` gives: approvals,
 * deliverables and audit events reference these rows, and a `DELETE` would either orphan them
 * or cascade through them.
 */

interface CreateClientOrganizationBody {
  readonly name?: unknown;
}

interface UpdateClientOrganizationBody {
  readonly updatedAt?: unknown;
  readonly name?: unknown;
}

interface InviteBody {
  readonly clientOrganizationId?: unknown;
  readonly userId?: unknown;
  readonly role?: unknown;
  /** Omitted: the policy default. `null`: open-ended, deliberately. */
  readonly expiresAt?: unknown;
}

interface UpdateMembershipBody {
  readonly updatedAt?: unknown;
  readonly role?: unknown;
  readonly expiresAt?: unknown;
  readonly status?: unknown;
}

interface ShareBody {
  readonly clientOrganizationId?: unknown;
}

interface SetClientBody {
  /** A client organization id, or `null` for "no client". */
  readonly clientOrganizationId?: unknown;
}

const INVITATION_STATUSES: readonly InvitationStatus[] = [
  'pending',
  'accepted',
  'expired',
  'revoked',
];

/** `client_organizations.name` is `VARCHAR(190)`. */
const MAX_NAME_LENGTH = 190;

const STATUSES: readonly ClientMembershipStatus[] = [
  'invited',
  'active',
  'suspended',
  'offboarded',
];

@Controller('v1/organizations/:orgSlug')
export class ClientsController {
  constructor(
    @Inject(CLIENTS_SERVICE) private readonly clients: ClientsService,
    @Inject(INVITATIONS_SERVICE) private readonly invitations: InvitationsService,
  ) {}

  // ── Client organizations ──────────────────────────────────────────────────

  @Get('client-organizations')
  @RequireCapability('org.manage')
  async listOrganizations(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<{ readonly clientOrganizations: readonly ClientOrganizationView[] }> {
    return {
      clientOrganizations: await this.clients.listOrganizations(context, principal, {
        includeArchived: includeArchived === 'true',
      }),
    };
  }

  /** BK1 / PRJ-02: the New project client picker — id and name of every active client. */
  @Get('client-organization-options')
  @RequireCapability('project.create')
  async listOrganizationOptions(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly clientOrganizations: readonly ClientOrganizationOption[] }> {
    return {
      clientOrganizations: await this.clients.listOrganizationOptions(context, principal),
    };
  }

  /**
   * BK1 / ADM-02: the invitations issued into one client company — pending ones unless `status`
   * says otherwise. Issue, resend and revoke stay on `/invitations` (`clientOrganizationId` in
   * the body, `:id/reissues`, `DELETE :id`); this is the per-company read the Clients screen needs.
   */
  @Get('client-organizations/:clientOrganizationId/invitations')
  @RequireCapability('org.manage')
  async listOrganizationInvitations(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
    @Query('status') status?: string,
  ): Promise<{ readonly invitations: readonly InvitationView[] }> {
    const statuses = status === undefined ? ['pending'] : status.split(',').map((v) => v.trim());
    const invalid = statuses.filter(
      (candidate) => !(INVITATION_STATUSES as readonly string[]).includes(candidate),
    );
    if (invalid.length > 0) {
      throw new ApiError(
        400,
        'validation_failed',
        'The query is invalid',
        invalid.map((candidate) => ({
          field: 'status',
          message: `${candidate} is not an invitation status`,
        })),
      );
    }

    // 404 for a client company that is not this tenant's, before any invitation is read.
    await this.clients.getOrganization(context, principal, clientOrganizationId);
    const all = await this.invitations.list(context, principal, {
      statuses: statuses as InvitationStatus[],
    });
    return {
      invitations: all.filter(
        (invitation) => invitation.clientOrganizationId === clientOrganizationId,
      ),
    };
  }

  @Get('client-organizations/:clientOrganizationId')
  @RequireCapability('org.manage')
  async getOrganization(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
  ): Promise<ClientOrganizationView> {
    return this.clients.getOrganization(context, principal, clientOrganizationId);
  }

  @Post('client-organizations')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async createOrganization(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateClientOrganizationBody,
  ): Promise<ClientOrganizationView> {
    const details: { field: string; message: string }[] = [];
    const name = requiredName(body?.name, details);
    if (details.length > 0 || name === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.clients.createOrganization(context, principal, name);
  }

  @Patch('client-organizations/:clientOrganizationId')
  @RequireCapability('org.manage')
  async updateOrganization(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
    @Body() body: UpdateClientOrganizationBody,
  ): Promise<ClientOrganizationView> {
    const details: { field: string; message: string }[] = [];
    const updatedAt = requiredToken(body?.updatedAt, details);
    const name = requiredName(body?.name, details);
    if (details.length > 0 || updatedAt === undefined || name === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.clients.updateOrganization(
      context,
      principal,
      clientOrganizationId,
      updatedAt,
      name,
    );
  }

  /**
   * Archive. `DELETE` as the method because that is what a caller means, and an archive as the
   * effect because that is what the data model does — the response body is the archived row, so
   * nothing about the outcome is left implied.
   */
  @Delete('client-organizations/:clientOrganizationId')
  @RequireCapability('org.manage')
  async archiveOrganization(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientOrganizationId') clientOrganizationId: string,
  ): Promise<ClientOrganizationView> {
    return this.clients.archiveOrganization(context, principal, clientOrganizationId);
  }

  // ── Client memberships ────────────────────────────────────────────────────

  @Get('client-memberships')
  @RequireCapability('client_member.manage')
  async listMemberships(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('clientOrganizationId') clientOrganizationId?: string,
    @Query('status') status?: string,
    @Query('includeExpired') includeExpired?: string,
  ): Promise<{ readonly clientMemberships: readonly ClientMembershipView[] }> {
    const details: { field: string; message: string }[] = [];
    const statuses =
      status === undefined ? undefined : status.split(',').map((value) => value.trim());
    if (statuses) {
      for (const candidate of statuses) {
        if (!isStatus(candidate)) {
          details.push({ field: 'status', message: `${candidate} is not a membership status` });
        }
      }
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return {
      clientMemberships: await this.clients.listMemberships(context, principal, {
        ...(clientOrganizationId ? { clientOrganizationId } : {}),
        ...(statuses ? { statuses: statuses as ClientMembershipStatus[] } : {}),
        includeExpired: includeExpired === 'true',
      }),
    };
  }

  @Post('client-memberships')
  @RequireCapability('client_member.manage')
  @HttpCode(201)
  async invite(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: InviteBody,
  ): Promise<ClientMembershipView> {
    const details: { field: string; message: string }[] = [];

    const clientOrganizationId =
      typeof body?.clientOrganizationId === 'string' ? body.clientOrganizationId : undefined;
    if (!clientOrganizationId) {
      details.push({ field: 'clientOrganizationId', message: 'must be a string' });
    }

    const userId = typeof body?.userId === 'string' ? body.userId : undefined;
    if (!userId) details.push({ field: 'userId', message: 'must be a string' });

    const role = typeof body?.role === 'string' ? body.role : undefined;
    if (!role || !isClientRole(role)) {
      details.push({ field: 'role', message: 'must be a client role' });
    }

    const expiresAt = optionalInstantOrNull(body?.expiresAt, 'expiresAt', details);

    if (details.length > 0 || !clientOrganizationId || !userId || !role || !isClientRole(role)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.clients.invite(context, principal, {
      clientOrganizationId,
      userId,
      role,
      // `undefined` means "the policy default" and `null` means "open-ended". The two are
      // different answers and the body distinguishes them, so the spread does too.
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }

  /**
   * Change one thing about a membership.
   *
   * Exactly one of `role`, `expiresAt` and `status` per request, and that is not fussiness:
   * each is a separate audit event describing a separate decision, and a body that changed a
   * role and offboarded somebody at once would have to be recorded as either one lie or two
   * events that did not happen independently.
   */
  @Patch('client-memberships/:clientMembershipId')
  @RequireCapability('client_member.manage')
  async updateMembership(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientMembershipId') clientMembershipId: string,
    @Body() body: UpdateMembershipBody,
  ): Promise<ClientMembershipView> {
    const details: { field: string; message: string }[] = [];
    const updatedAt = requiredToken(body?.updatedAt, details);

    const asked = ['role', 'expiresAt', 'status'].filter((field) => field in (body ?? {}));
    if (asked.length !== 1) {
      details.push({
        field: 'body',
        message: 'change exactly one of role, expiresAt or status per request',
      });
    }

    if (details.length > 0 || updatedAt === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    if (asked[0] === 'role') {
      const role = typeof body.role === 'string' ? body.role : undefined;
      if (!role || !isClientRole(role)) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'role', message: 'must be a client role' },
        ]);
      }
      return this.clients.changeRole(context, principal, clientMembershipId, updatedAt, role);
    }

    if (asked[0] === 'expiresAt') {
      const expiresAt = optionalInstantOrNull(body.expiresAt, 'expiresAt', details);
      if (details.length > 0 || expiresAt === undefined) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          ...details,
          ...(expiresAt === undefined
            ? [{ field: 'expiresAt', message: 'must be an instant or null' }]
            : []),
        ]);
      }
      return this.clients.setExpiry(context, principal, clientMembershipId, updatedAt, expiresAt);
    }

    const status = typeof body.status === 'string' ? body.status : undefined;
    if (!status || !isStatus(status)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'status', message: `must be one of ${STATUSES.join(', ')}` },
      ]);
    }
    return this.clients.changeStatus(context, principal, clientMembershipId, updatedAt, status);
  }

  // ── Project sharing ───────────────────────────────────────────────────────

  @Get('projects/:projectId/clients')
  @RequireCapability('project.manage')
  async listShares(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly clients: readonly ProjectClientView[] }> {
    return { clients: await this.clients.listShares(context, principal, projectId) };
  }

  @Post('projects/:projectId/clients')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async share(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: ShareBody,
  ): Promise<ProjectClientView> {
    const clientOrganizationId =
      typeof body?.clientOrganizationId === 'string' ? body.clientOrganizationId : undefined;
    if (!clientOrganizationId) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'clientOrganizationId', message: 'must be a string' },
      ]);
    }

    return this.clients.share(context, principal, projectId, clientOrganizationId);
  }

  /**
   * BK1 / PRJ-02: set the project's client (or `null` for none), replacing any existing share —
   * what the New project and Edit project forms send after the project itself is saved.
   */
  @Put('projects/:projectId/client')
  @RequireCapability('project.manage')
  async setClient(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: SetClientBody,
  ): Promise<{ readonly clients: readonly ProjectClientView[] }> {
    const raw = body?.clientOrganizationId;
    if (raw !== null && (typeof raw !== 'string' || raw === '')) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'clientOrganizationId', message: 'must be a string or null' },
      ]);
    }

    return { clients: await this.clients.setProjectClient(context, principal, projectId, raw) };
  }

  @Delete('projects/:projectId/clients/:clientOrganizationId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async unshare(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('clientOrganizationId') clientOrganizationId: string,
  ): Promise<void> {
    await this.clients.unshare(context, principal, projectId, clientOrganizationId);
  }
}

function isStatus(value: string): value is ClientMembershipStatus {
  return (STATUSES as readonly string[]).includes(value);
}

function requiredName(
  raw: unknown,
  details: { field: string; message: string }[],
): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') {
    details.push({ field: 'name', message: 'must be a non-empty string' });
    return undefined;
  }
  const value = raw.trim();
  if (value.length > MAX_NAME_LENGTH) {
    details.push({ field: 'name', message: `must be ${MAX_NAME_LENGTH} characters or fewer` });
    return undefined;
  }
  return value;
}

/**
 * The concurrency token: `updated_at`, as the ISO 8601 string the caller read back.
 *
 * Required rather than optional, so a caller cannot opt out of optimistic concurrency by
 * leaving a field off. Compared as an instant rather than as text — the same moment can be
 * written several ways and a string comparison would refuse a correct token.
 */
function requiredToken(
  raw: unknown,
  details: { field: string; message: string }[],
): Date | undefined {
  if (typeof raw !== 'string') {
    details.push({ field: 'updatedAt', message: 'must be the updatedAt you read' });
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field: 'updatedAt', message: 'is not a real instant' });
    return undefined;
  }
  return parsed;
}

/**
 * An instant, `null`, or absent — and all three mean different things.
 *
 * Absent: use the policy default. `null`: open-ended, deliberately. An instant: that instant.
 * A bare calendar date is refused rather than guessed at midnight, because "access ends on
 * the 30th" and "access ends at midnight UTC on the 30th" are not the same promise to somebody
 * in another timezone.
 */
function optionalInstantOrNull(
  raw: unknown,
  field: string,
  details: { field: string; message: string }[],
): Date | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;

  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    details.push({ field, message: 'must be an ISO 8601 instant, such as 2027-01-31T00:00:00Z' });
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: 'is not a real instant' });
    return undefined;
  }
  return parsed;
}
