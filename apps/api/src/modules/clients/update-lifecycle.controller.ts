import { Body, Controller, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PORTAL_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PortalService, UpdateEditView } from './portal.service.js';

/**
 * x201's internal write surface — editing and unpublishing a project update that pass 19/20
 * (x125) could only ever create.
 *
 * A controller of its own, on the **internal** `projects` path rather than under `/portal`, for
 * the same security reason `ProjectUpdatesController` (the create route) is: `/portal` serves the
 * client projection, and a client role holds none of the capabilities these routes require, so
 * keeping the lifecycle off the portal path means a client principal never reaches it. It is a
 * distinct file from the create controller (and from x125's web timeline) so the two do not
 * collide as x201 is integrated.
 *
 * Both routes are behind `project.manage`. `CapabilityGuard` refuses a principal without that
 * capability — every client role — with 403 before the handler runs; the service then applies the
 * finer per-project gate, resolving `:projectId`/`:id` tenant-scoped and answering 404 (never a
 * 403 that would confirm the row) for anything the caller cannot manage.
 */

/** `project_updates.title` is VARCHAR(300). */
const MAX_UPDATE_TITLE_LENGTH = 300;

interface EditUpdateBody {
  readonly title?: unknown;
  readonly body?: unknown;
}

@Controller('v1/organizations/:orgSlug/projects')
export class UpdateLifecycleController {
  constructor(@Inject(PORTAL_SERVICE) private readonly portal: PortalService) {}

  /**
   * Edit an update's client-facing title/body. A partial edit: either field may be sent, but at
   * least one must be, and any field sent must be a non-empty string within its bound. `published`
   * is not editable here — publishing is the create route's flag, unpublishing is the route below.
   */
  @Patch(':projectId/updates/:id')
  @RequireCapability('project.manage')
  async edit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') updateId: string,
    @Body() body: EditUpdateBody,
  ): Promise<UpdateEditView> {
    const details: { field: string; message: string }[] = [];

    let title: string | undefined;
    if (body?.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        details.push({ field: 'title', message: 'must be a non-empty string' });
      } else if (body.title.trim().length > MAX_UPDATE_TITLE_LENGTH) {
        details.push({
          field: 'title',
          message: `must be ${MAX_UPDATE_TITLE_LENGTH} characters or fewer`,
        });
      } else {
        title = body.title.trim();
      }
    }

    let updateBody: string | undefined;
    if (body?.body !== undefined) {
      if (typeof body.body !== 'string' || body.body.trim() === '') {
        details.push({ field: 'body', message: 'must be a non-empty string' });
      } else {
        updateBody = body.body.trim();
      }
    }

    if (title === undefined && updateBody === undefined && details.length === 0) {
      details.push({ field: 'title', message: 'at least one of title or body is required' });
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.portal.editUpdate(context, principal, {
      projectId,
      updateId,
      ...(title !== undefined ? { title } : {}),
      ...(updateBody !== undefined ? { body: updateBody } : {}),
    });
  }

  /**
   * Unpublish an update — flip `published` to draft so it disappears from the client projection.
   * No body; the id is the whole request. `200` rather than `201`: nothing is created, an existing
   * row's visibility changes, and the changed row is returned.
   */
  @Post(':projectId/updates/:id/unpublish')
  @RequireCapability('project.manage')
  @HttpCode(200)
  async unpublish(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('id') updateId: string,
  ): Promise<UpdateEditView> {
    return this.portal.unpublishUpdate(context, principal, { projectId, updateId });
  }
}
