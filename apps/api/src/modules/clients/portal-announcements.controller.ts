import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PORTAL_ANNOUNCEMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_PORTAL_ANNOUNCEMENT_BODY_LENGTH,
  MAX_PORTAL_ANNOUNCEMENT_TITLE_LENGTH,
  type ClientPortalAnnouncementView,
  type PortalAnnouncementView,
  type PortalAnnouncementsService,
} from './portal-announcements.service.js';

/**
 * POR client portal (x304) — the HTTP surface for a pinned announcement banner.
 *
 * All three routes are on the `/portal/:clientId` path. The **write** routes — POST (post a banner)
 * and DELETE (retract) — are behind `client_member.manage`, the capability an internal staffer holds
 * to curate a client relationship; `CapabilityGuard` refuses a role without it with 403 before the
 * handler runs. The **read** route — GET the banners active now — is behind `client_projection.read`,
 * the portal side. The service resolves the client organization inside the acting tenant *before* it
 * authorizes, so a cross-tenant id is a 404 with no write; no `clientId` is ever read from a body.
 */

interface PostAnnouncementBody {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly startsAt?: unknown;
  readonly endsAt?: unknown;
}

function requiredText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be a non-empty string' },
    ]);
  }
  const text = raw.trim();
  if (text.length > max) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: `must be ${max} characters or fewer` },
    ]);
  }
  return text;
}

/** Parse an optional ISO-8601 instant. Present-but-unparseable is a 400; absent is `undefined`. */
function optionalInstant(raw: unknown, field: string): Date | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be an ISO-8601 date-time string' },
    ]);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be an ISO-8601 date-time string' },
    ]);
  }
  return parsed;
}

@Controller('v1/organizations/:orgSlug/portal/:clientId/announcements')
export class PortalAnnouncementsController {
  constructor(
    @Inject(PORTAL_ANNOUNCEMENTS_SERVICE)
    private readonly announcements: PortalAnnouncementsService,
  ) {}

  /**
   * The banners active now for this client — the portal read, `client_projection.read`. A client
   * reading another client's path is a 404 from the service, never an empty list.
   */
  @Get()
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientId') clientId: string,
  ): Promise<{ readonly announcements: readonly ClientPortalAnnouncementView[] }> {
    return {
      announcements: await this.announcements.listActiveForClient(context, principal, clientId),
    };
  }

  /** Post a banner — internal, `client_member.manage`. Empty title or `endsAt <= startsAt` is a 400. */
  @Post()
  @RequireCapability('client_member.manage')
  @HttpCode(201)
  async post(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientId') clientId: string,
    @Body() body: PostAnnouncementBody,
  ): Promise<PortalAnnouncementView> {
    const title = requiredText(body?.title, 'title', MAX_PORTAL_ANNOUNCEMENT_TITLE_LENGTH);
    const text = requiredText(body?.body, 'body', MAX_PORTAL_ANNOUNCEMENT_BODY_LENGTH);
    const startsAt = optionalInstant(body?.startsAt, 'startsAt');
    const endsAt = optionalInstant(body?.endsAt, 'endsAt');

    return this.announcements.create(context, principal, clientId, {
      title,
      body: text,
      ...(startsAt === undefined ? {} : { startsAt }),
      ...(endsAt === undefined ? {} : { endsAt }),
    });
  }

  /** Retract a banner — internal, `client_member.manage`. Idempotent: 204 whether or not it existed. */
  @Delete(':announcementId')
  @RequireCapability('client_member.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientId') clientId: string,
    @Param('announcementId') announcementId: string,
  ): Promise<void> {
    await this.announcements.remove(context, principal, clientId, announcementId);
  }
}
