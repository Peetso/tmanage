import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PORTAL_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PortalService, PortalUpdateView } from './portal.service.js';

/**
 * CLIENT-003's internal write surface — a project manager posting an update to a client's portal
 * timeline.
 *
 * A controller of its own, on the **internal** `projects` path rather than under `/portal`, and
 * that is a security property rather than a routing preference. `/portal` serves the client
 * projection; posting an update is an internal act behind `project.manage`, which no client role
 * holds. Keeping the write off the portal path means a client principal never reaches it, the
 * same reason `PortalController` exists as a path of its own for the reads.
 *
 * The route lives in `ClientsModule` beside `PortalController` because the two share one
 * `PortalService`: the update is resolved, relation-checked and written there, and the client
 * read of the same rows is one method over. A second controller rather than a method on
 * `ProjectsController` keeps that cohesion — `ProjectsController` (in `ProjectsModule`) has no
 * handle on `PORTAL_SERVICE`, and reaching for one would register the dynamic module twice.
 *
 * `POST projects/:projectId/updates` does not collide with `ProjectsController`'s `POST projects`
 * — different paths — so both controllers carry the same prefix without contention.
 */

/** `project_updates.title` is VARCHAR(300). */
const MAX_UPDATE_TITLE_LENGTH = 300;

interface PostUpdateBody {
  readonly title?: unknown;
  readonly body?: unknown;
  /**
   * Whether the update is client-visible. Optional; **defaults to `true`** — an update posted to
   * a client's portal timeline is meant to be seen, and a draft is the explicit opt-out
   * (`published: false`). This slice sets the flag at insert; the publish/unpublish lifecycle is
   * a later slice (NEXT-SCOPES-12).
   */
  readonly published?: unknown;
}

@Controller('v1/organizations/:orgSlug/projects')
export class ProjectUpdatesController {
  constructor(@Inject(PORTAL_SERVICE) private readonly portal: PortalService) {}

  @Post(':projectId/updates')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async post(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: PostUpdateBody,
  ): Promise<PortalUpdateView> {
    const details: { field: string; message: string }[] = [];

    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    if (!title) {
      details.push({ field: 'title', message: 'must be a non-empty string' });
    } else if (title.length > MAX_UPDATE_TITLE_LENGTH) {
      details.push({
        field: 'title',
        message: `must be ${MAX_UPDATE_TITLE_LENGTH} characters or fewer`,
      });
    }

    const updateBody = typeof body?.body === 'string' ? body.body.trim() : undefined;
    if (!updateBody) {
      details.push({ field: 'body', message: 'must be a non-empty string' });
    }

    if (body?.published !== undefined && typeof body.published !== 'boolean') {
      details.push({ field: 'published', message: 'must be a boolean' });
    }
    const published = body?.published === undefined ? true : (body.published as boolean);

    if (details.length > 0 || !title || !updateBody) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.portal.postUpdate(context, principal, {
      projectId,
      title,
      body: updateBody,
      published,
    });
  }
}
