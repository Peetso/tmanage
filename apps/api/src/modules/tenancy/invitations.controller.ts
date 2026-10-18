import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import {
  Ctx,
  CurrentPrincipal,
  CurrentSession,
  NoTenant,
  Public,
  RequireCapability,
} from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { AuthenticatedSession, SessionService } from '../identity/session.service.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import {
  INVITATION_REGISTRATION_ADMISSION,
  INVITATION_REGISTRATION_SESSIONS,
} from './invitation-registration.tokens.js';
import { INVITATIONS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InvitationStatus } from './invitations.repository.js';
import type {
  AcceptedInvitationView,
  InvitationPreviewView,
  InvitationView,
  InvitationsService,
  IssuedInvitationView,
} from './invitations.service.js';

/** The registration body: the token, the new account's name and its first password. */
interface RegisterBody {
  readonly token?: unknown;
  readonly displayName?: unknown;
  readonly password?: unknown;
}

/** Wire body of a registration (contracts-check pairs it with apps/web/src/lib/api/invitations.ts). */
export interface InvitationRegistrationView {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly clientOrganizationId: string | null;
  readonly role: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

/**
 * TEN-003's HTTP surface — the tenant-scoped half.
 *
 * Issuing, listing, re-issuing and revoking all happen inside an organization the caller is
 * already a member of, so they are ordinary routes behind the ordinary four guards.
 *
 * **Accepting is not here.** It cannot be: the person accepting has no membership, so
 * `TenantContextGuard` has nothing to resolve and no slug belongs in the path. That route is
 * `InvitationAcceptanceController`, below, and it carries `@NoTenant()` — a visible line in a
 * diff rather than the silent consequence of a missing annotation.
 */

interface IssueBody {
  readonly email?: unknown;
  readonly role?: unknown;
  readonly clientOrganizationId?: unknown;
}

interface ReissueBody {
  readonly role?: unknown;
}

interface AcceptBody {
  readonly token?: unknown;
}

/**
 * The shape this controller needs from the request, and nothing more.
 *
 * A structural type rather than `FastifyRequest`, the same way `AuthenticationController` and
 * `SessionController` declare theirs: `apps/api` does not depend on `fastify` directly — it
 * arrives through `@nestjs/platform-fastify` — and naming the two properties that are actually
 * read keeps the handler testable with a plain object.
 */
interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

const STATUSES: readonly InvitationStatus[] = ['pending', 'accepted', 'expired', 'revoked'];

/** `invitations.email` is `VARCHAR(320)` — the maximum length of an address. */
const MAX_EMAIL_LENGTH = 320;

@Controller('v1/organizations/:orgSlug/invitations')
export class InvitationsController {
  constructor(@Inject(INVITATIONS_SERVICE) private readonly invitations: InvitationsService) {}

  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('status') status?: string,
  ): Promise<{ readonly invitations: readonly InvitationView[] }> {
    const details: { field: string; message: string }[] = [];
    const statuses =
      status === undefined ? undefined : status.split(',').map((value) => value.trim());
    if (statuses) {
      for (const candidate of statuses) {
        if (!isStatus(candidate)) {
          details.push({ field: 'status', message: `${candidate} is not an invitation status` });
        }
      }
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    return {
      invitations: await this.invitations.list(context, principal, {
        ...(statuses ? { statuses: statuses as InvitationStatus[] } : {}),
      }),
    };
  }

  /**
   * Issue one. The token is in the response **once** — `22-SCREEN-BY-SCREEN` §3 ON-06 builds
   * the link from it — and there is no route that can produce it again, because the row holds
   * only a hash.
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async issue(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: IssueBody,
  ): Promise<IssuedInvitationView> {
    const details: { field: string; message: string }[] = [];
    const email = requiredEmail(body?.email, details);

    const role = typeof body?.role === 'string' && body.role !== '' ? body.role : undefined;
    if (!role) details.push({ field: 'role', message: 'must be a non-empty string' });

    const clientOrganizationId =
      body?.clientOrganizationId === undefined || body.clientOrganizationId === null
        ? null
        : typeof body.clientOrganizationId === 'string'
          ? body.clientOrganizationId
          : undefined;
    if (clientOrganizationId === undefined) {
      details.push({ field: 'clientOrganizationId', message: 'must be a string or null' });
    }

    if (details.length > 0 || email === undefined || !role || clientOrganizationId === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.invitations.issue(context, principal, { email, role, clientOrganizationId });
  }

  /**
   * Revoke the old one and issue a new one — `23-ERD` §9's "role/scope change after issuance".
   *
   * `POST` to a sub-resource rather than `PATCH` on the invitation, because nothing about the
   * old row changes except its status: the result is a **different invitation** with a
   * different id and a different token, and a `PATCH` returning a new id would be a lie about
   * what happened.
   */
  @Post(':invitationId/reissues')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async reissue(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invitationId') invitationId: string,
    @Body() body: ReissueBody,
  ): Promise<IssuedInvitationView> {
    const role = typeof body?.role === 'string' && body.role !== '' ? body.role : undefined;
    if (body?.role !== undefined && role === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'role', message: 'must be a non-empty string' },
      ]);
    }

    return this.invitations.reissue(context, principal, invitationId, {
      ...(role === undefined ? {} : { role }),
    });
  }

  @Delete(':invitationId')
  @RequireCapability('org.manage')
  async revoke(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invitationId') invitationId: string,
  ): Promise<InvitationView> {
    return this.invitations.revoke(context, principal, invitationId);
  }

  /**
   * Sweep this tenant's overdue invitations into `expired`.
   *
   * A route rather than a background job because `apps/worker` does not exist yet. It is
   * bookkeeping either way: an overdue invitation is already unusable, because the acceptance
   * path compares `expires_at` in the database whether or not this has ever run.
   */
  @Post('expirations')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async expire(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly expired: number }> {
    return { expired: await this.invitations.expireOverdue(context, principal) };
  }
}

/**
 * Acceptance — the route with no tenant.
 *
 * `@NoTenant()` because there is nothing to resolve: the person following the link has no
 * membership in the organization, which is precisely what they are about to be given. The
 * session guard still runs, so the caller is a verified account; the invitation supplies the
 * organization.
 *
 * The token travels in the **body**, not the path. A token in a URL is in the browser's
 * history, in any `Referer` header the next navigation sends, and in every access log between
 * here and the client — and this one is a credential that grants membership in an
 * organization. `ID-002`'s MFA challenge token is kept out of URLs for the same reason, and
 * `apps/web`'s `ID-03` screen already reads its token from the route without echoing it.
 *
 * The caller is identified by `@CurrentSession()` rather than `@CurrentPrincipal()`, and the
 * difference matters: a `Principal` is assembled by `TenantContextGuard` from a membership
 * row, and on a route with no tenant there is none to assemble. The session is what exists
 * here — a verified account and nothing more — which is exactly the amount of authority
 * accepting an invitation needs.
 */
@Controller('v1/invitations')
export class InvitationAcceptanceController {
  constructor(
    @Inject(INVITATIONS_SERVICE) private readonly invitations: InvitationsService,
    @Inject(INVITATION_REGISTRATION_SESSIONS) private readonly sessions: SessionService,
    @Inject(INVITATION_REGISTRATION_ADMISSION) private readonly admit: RequestAdmission,
  ) {}

  /**
   * What `ID-03` shows before anybody accepts.
   *
   * `@Public()` as well as `@NoTenant()`, because the link arrives by email and the recipient
   * may not have signed in yet — `22-SCREEN-BY-SCREEN` §3's "account-switch option" assumes
   * exactly that. What gates the read is the 256-bit token, which is not enumerable; what it
   * discloses is what the invitation was always going to tell the person it was sent to.
   *
   * `POST` for a read, and the token in the body, for the reason acceptance gives.
   */
  @Post('previews')
  @Public()
  @NoTenant()
  @HttpCode(200)
  async preview(
    @Req() request: RequestLike,
    @Body() body: AcceptBody,
  ): Promise<InvitationPreviewView> {
    const token = typeof body?.token === 'string' ? body.token : undefined;
    if (!token) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'token', message: 'must be a string' },
      ]);
    }

    return this.invitations.preview(token, requireRequestState(request).correlationId);
  }

  @Post('acceptances')
  @NoTenant()
  @HttpCode(201)
  async accept(
    @Req() request: RequestLike,
    @CurrentSession() session: AuthenticatedSession,
    @Body() body: AcceptBody,
  ): Promise<AcceptedInvitationView> {
    const token = typeof body?.token === 'string' ? body.token : undefined;
    if (!token) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'token', message: 'must be a string' },
      ]);
    }

    return this.invitations.accept(
      token,
      session.userId,
      requireRequestState(request).correlationId,
    );
  }

  /**
   * ACC-01: a brand-new invitee sets their name and password and joins in one step.
   *
   * `@Public()` and `@NoTenant()` like the preview: the person has no account yet, so there is
   * no session to require — the token, which was mailed to the address the account is created
   * for, is the credential. Rate-limited per address before anything else, because the route
   * hashes a password. On success the new account is signed in exactly as
   * `FirstOwnerController` signs in the first owner: the session starts after the creating
   * transaction has committed.
   */
  @Post('registrations')
  @Public()
  @NoTenant()
  @HttpCode(201)
  async register(
    @Req() request: RequestLike,
    @Body() body: RegisterBody,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<InvitationRegistrationView> {
    const state = requireRequestState(request);
    if (!this.admit(request.ip ?? 'unknown')) {
      throw new ApiError(
        429,
        'rate_limited',
        'Too many attempts. Wait a few minutes and try again.',
      );
    }
    const token = typeof body?.token === 'string' ? body.token : undefined;
    if (!token) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'token', message: 'must be a string' },
      ]);
    }

    const registered = await this.invitations.register(
      token,
      { displayName: body.displayName, password: body.password },
      state.correlationId,
    );

    const userAgent = request.headers['user-agent'];
    const established = await this.sessions.start({
      userId: registered.userId,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      correlationId: state.correlationId,
    });
    reply.header('set-cookie', established.cookies);
    return {
      status: 'authenticated',
      csrfToken: established.csrfToken,
      expiresAt: established.expiresAt.toISOString(),
      organizationId: registered.organizationId,
      membershipId: registered.membershipId,
      clientOrganizationId: registered.clientOrganizationId,
      role: registered.role,
    };
  }
}

function isStatus(value: string): value is InvitationStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/**
 * An address, normalised the way the service stores it.
 *
 * Deliberately not a strict RFC 5322 validation: the only shape that matters here is "has a
 * local part, an @, and a domain", and a stricter pattern refuses real addresses more often
 * than it catches typos. Whether an address can receive mail is decided by whether the mail
 * arrives.
 */
function requiredEmail(
  raw: unknown,
  details: { field: string; message: string }[],
): string | undefined {
  if (typeof raw !== 'string') {
    details.push({ field: 'email', message: 'must be a string' });
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (
    value.length === 0 ||
    value.length > MAX_EMAIL_LENGTH ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
  ) {
    details.push({ field: 'email', message: 'must be an email address' });
    return undefined;
  }
  return value;
}
