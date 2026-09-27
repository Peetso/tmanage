import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { OrgAnnouncementsService } from './announcements.service.js';
import type { AnnouncementView } from './announcements.service.js';

/**
 * Org-wide admin announcement banners (Administration module 18, x276). An org admin posts a banner and
 * deletes one; any member reads the banners active right now. Like every tenant-scoped controller here
 * it never reads `organizationId` (or the acting membership) from the body, a header or its `:orgSlug`
 * segment: it receives the `TenantContext` that `TenantContextGuard` built from a membership row and
 * passes it on.
 *
 * The admin write surface lives under `admin/announcements` behind `org.manage`; the member read surface
 * lives at the distinct top-level `announcements` behind `work.read` (an authenticated member), so the
 * two capabilities are enforced at the route by their own controllers. Both live in one module
 * (registered in `app.module.ts`, the shared append point) so the slice touches no file another
 * administration slice appends to.
 */

const ORG_ANNOUNCEMENTS_SERVICE = Symbol.for('tmanage.OrgAnnouncementsService');

/** The POST body — a title, a body and an optional active window, all arriving as `unknown`. */
interface CreateAnnouncementBody {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly startsAt?: unknown;
  readonly endsAt?: unknown;
}

@Controller('v1/organizations/:orgSlug/admin/announcements')
export class AdminAnnouncementsController {
  constructor(
    @Inject(ORG_ANNOUNCEMENTS_SERVICE) private readonly announcements: OrgAnnouncementsService,
  ) {}

  /**
   * Post an announcement for the org (200 — the created banner). Behind `org.manage`; the service
   * re-authorizes org-wide (403 no insert), validates the title/body/window (400 no insert), then
   * inserts.
   */
  @Post()
  @RequireCapability('org.manage')
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateAnnouncementBody,
  ): Promise<AnnouncementView> {
    return this.announcements.create(context, principal, {
      title: asOptionalString(body?.title) ?? '',
      body: asOptionalString(body?.body) ?? '',
      startsAt: asOptionalString(body?.startsAt),
      endsAt: asOptionalString(body?.endsAt),
    });
  }

  /**
   * Delete an announcement (idempotent, 204). Behind `org.manage`; the service resolves the id
   * tenant-scoped FIRST (unknown/cross-tenant → 404 no delete) before it re-authorizes (Known-trap).
   */
  @Delete(':id')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    requireId(id);
    await this.announcements.remove(context, principal, id);
  }
}

@Controller('v1/organizations/:orgSlug/announcements')
export class MemberAnnouncementsController {
  constructor(
    @Inject(ORG_ANNOUNCEMENTS_SERVICE) private readonly announcements: OrgAnnouncementsService,
  ) {}

  /** List the org's announcements active right now, for a member of the org. Behind `work.read`. */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly announcements: readonly AnnouncementView[] }> {
    return { announcements: await this.announcements.listActive(context) };
  }
}

/** A path `id` is always required and always a non-empty string. */
function requireId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new ApiError(400, 'validation_failed', 'id is required', [
      { field: 'id', message: 'must be a non-empty string' },
    ]);
  }
}

/** Read an optional string field from the body, or `null` when it is absent/non-string. */
function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * x276's wiring — a self-contained module registered from `app.module.ts` (the shared append point),
 * file-disjoint from the other administration slices. The service is constructed with the `@Global`
 * `TENANT_DATABASE`; both controllers share the one instance.
 */
@Module({})
export class OrgAnnouncementsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: ORG_ANNOUNCEMENTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new OrgAnnouncementsService(database),
    };

    return {
      module: OrgAnnouncementsModule,
      providers: [service],
      controllers: [AdminAnnouncementsController, MemberAnnouncementsController],
    };
  }
}
