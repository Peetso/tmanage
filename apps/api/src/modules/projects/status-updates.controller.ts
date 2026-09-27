import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_STATUS_UPDATES_SERVICE } from '../../common/http/tokens.js';
import { PROJECT_STATUS_BANDS } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ProjectStatusUpdatePageView,
  ProjectStatusUpdatesService,
  ProjectStatusUpdateView,
} from './status-updates.service.js';
import type { ProjectStatusBand } from './status-updates.repository.js';

/**
 * PROJ / module 8 (x235). A project's **internal** status-update log: post an update, list the log.
 *
 * Nested under `…/projects/:projectId/status-updates`, so the project is named in the path and the
 * service resolves it tenant-scoped before it authorizes or writes (Known-trap). Gated on
 * `project.manage` for both the post and the list — this is the studio's own status changelog, posted
 * and read by the people who manage the project. Like every tenant-scoped controller here, it never
 * reads `organizationId` from the body, a header, or its own `:orgSlug` segment.
 *
 * This is distinct from x125's `POST/GET …/projects/:projectId/updates` (the clients-module surface
 * that publishes an update to a client's portal): a different path (`status-updates`), a different
 * table (`project_status_updates`), and internal-only — never projected to a client.
 */

interface CreateStatusUpdateBody {
  readonly statusBand?: unknown;
  readonly body?: unknown;
}

/** `project_status_updates.body` is `TEXT`; this is a form field, not a document. */
const MAX_BODY_LENGTH = 20_000;

function isStatusBand(value: unknown): value is ProjectStatusBand {
  return typeof value === 'string' && (PROJECT_STATUS_BANDS as readonly string[]).includes(value);
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/status-updates')
export class ProjectStatusUpdatesController {
  constructor(
    @Inject(PROJECT_STATUS_UPDATES_SERVICE)
    private readonly updates: ProjectStatusUpdatesService,
  ) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<ProjectStatusUpdatePageView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return this.updates.list(context, principal, {
      projectId,
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      ...(typeof before === 'string' && before !== '' ? { before } : {}),
    });
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreateStatusUpdateBody,
  ): Promise<ProjectStatusUpdateView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const text = typeof body?.body === 'string' ? body.body.trim() : undefined;

    const details = [
      ...(isStatusBand(body?.statusBand)
        ? []
        : [
            {
              field: 'statusBand',
              message: `must be one of ${PROJECT_STATUS_BANDS.join(', ')}`,
            },
          ]),
      ...(text ? [] : [{ field: 'body', message: 'must be a non-empty string' }]),
      ...(text && text.length > MAX_BODY_LENGTH
        ? [{ field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` }]
        : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!isStatusBand(body?.statusBand) || !text) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.updates.create(context, principal, {
      projectId,
      statusBand: body.statusBand,
      body: text,
    });
  }
}
