import { Controller, Get, Inject, Query } from '@nestjs/common';
import { uuidv7 } from '@tmanage/domain';
import { Public } from '../../common/http/decorators.js';
import { PlatformAnnouncementsRepository } from '../platform-admin/settings/announcements.repository.js';
import { pickPublicAnnouncement } from '../platform-admin/settings/announcements.service.js';
import type {
  AnnouncementViewer,
  PublicAnnouncementsView,
} from '../platform-admin/settings/announcements.service.js';

/** The ids this read accepts as a viewer's organization. Anything else is "no organization". */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,79}$/u;

/**
 * `GET /public/site/announcements?locale=en|ar&surface=app|portal&organizationId=` — the platform
 * banner (PA-10, SPEC §5.6), beside `GET /public/site/maintenance`.
 *
 * `@Public()`: the app shell and the client portal read it before anything else, like the
 * maintenance banner. It returns at most one announcement — the most severe live one for the
 * viewer — already in the requested language (English when no Arabic text was written). A banner
 * for chosen organizations shows only inside those organizations' app; a client-portal banner only
 * in portals. What a banner says is public by design: it is shown on screen to its whole audience.
 *
 * Registered by `MaintenanceModule` (`platform/maintenance.controller.ts`), which already serves
 * the public site's other platform-state read, so no shared module file changes.
 */
@Controller('public/site')
export class PublicSiteAnnouncementsController {
  constructor(
    @Inject(PlatformAnnouncementsRepository)
    private readonly repository: PlatformAnnouncementsRepository,
  ) {}

  @Get('announcements')
  @Public()
  async current(
    @Query('locale') locale?: string,
    @Query('surface') surface?: string,
    @Query('organizationId') organizationId?: string,
    @Query('organizationSlug') organizationSlug?: string,
  ): Promise<PublicAnnouncementsView> {
    const now = new Date();
    const correlationId = uuidv7();
    const live = await this.repository.live(now, correlationId);
    let resolvedOrganization =
      typeof organizationId === 'string' && UUID_SHAPE.test(organizationId) ? organizationId : null;
    // Resolve the slug only when a live banner is aimed at chosen organizations.
    if (
      resolvedOrganization === null &&
      typeof organizationSlug === 'string' &&
      SLUG_SHAPE.test(organizationSlug) &&
      live.some((record) => record.audience === 'organizations')
    ) {
      resolvedOrganization = await this.repository
        .organizationIdForSlug(organizationSlug, correlationId)
        .catch(() => null);
    }
    const viewer: AnnouncementViewer = {
      surface: surface === 'app' || surface === 'portal' ? surface : 'site',
      organizationId: resolvedOrganization,
    };
    return {
      announcement: pickPublicAnnouncement(live, viewer, locale === 'ar' ? 'ar' : 'en', now),
      asOf: now.toISOString(),
    };
  }
}
