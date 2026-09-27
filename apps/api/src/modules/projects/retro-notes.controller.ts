import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_RETRO_NOTES_SERVICE } from '../../common/http/tokens.js';
import { PROJECT_RETRO_NOTE_CATEGORIES } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ProjectRetroBoardView,
  ProjectRetroNotesService,
  ProjectRetroNoteView,
} from './retro-notes.service.js';
import type { ProjectRetroNoteCategory } from './retro-notes.repository.js';

/**
 * PROJ / module 8 (x311). A project's retrospective-notes log: capture a note, list them grouped by
 * category, delete one.
 *
 * Nested under `…/projects/:projectId/retro-notes`, so the project is named in the path and the
 * service resolves it tenant-scoped before it authorizes or writes (Known-trap). Gated on
 * `project.manage` for every route — this is the studio's own reflection log, captured and read by
 * the people who manage the project. Like every tenant-scoped controller here, it never reads
 * `organizationId` from the body, a header, or its own `:orgSlug` segment.
 */

interface CreateRetroNoteBody {
  readonly category?: unknown;
  readonly body?: unknown;
  readonly milestoneId?: unknown;
}

/** `project_retro_notes.body` is `TEXT`; this is a form field, not a document. */
const MAX_BODY_LENGTH = 20_000;

function isCategory(value: unknown): value is ProjectRetroNoteCategory {
  return (
    typeof value === 'string' &&
    (PROJECT_RETRO_NOTE_CATEGORIES as readonly string[]).includes(value)
  );
}

function requireProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new ApiError(400, 'validation_failed', 'projectId is required', [
      { field: 'projectId', message: 'must be a non-empty string' },
    ]);
  }
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/retro-notes')
export class ProjectRetroNotesController {
  constructor(
    @Inject(PROJECT_RETRO_NOTES_SERVICE)
    private readonly notes: ProjectRetroNotesService,
  ) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectRetroBoardView> {
    requireProjectId(projectId);
    return this.notes.list(context, principal, projectId);
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreateRetroNoteBody,
  ): Promise<ProjectRetroNoteView> {
    requireProjectId(projectId);

    const text = typeof body?.body === 'string' ? body.body.trim() : undefined;
    const milestoneId =
      typeof body?.milestoneId === 'string' && body.milestoneId.trim() !== ''
        ? body.milestoneId.trim()
        : null;

    const details = [
      ...(isCategory(body?.category)
        ? []
        : [
            {
              field: 'category',
              message: `must be one of ${PROJECT_RETRO_NOTE_CATEGORIES.join(', ')}`,
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
    if (!isCategory(body?.category) || !text) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.notes.create(context, principal, {
      projectId,
      milestoneId,
      category: body.category,
      body: text,
    });
  }

  @Delete(':noteId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('noteId') noteId: string,
  ): Promise<void> {
    requireProjectId(projectId);
    if (typeof noteId !== 'string' || noteId === '') {
      throw new ApiError(400, 'validation_failed', 'noteId is required', [
        { field: 'noteId', message: 'must be a non-empty string' },
      ]);
    }
    await this.notes.delete(context, principal, projectId, noteId);
  }
}
