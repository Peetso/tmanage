import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE, WORKSPACES_REPOSITORY } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkspacesRepository } from './workspaces.repository.js';

/**
 * The workspace list — the smallest endpoint in the system, and it exists for one reason.
 *
 * `ON-03` has to put a project somewhere. `07-DATA-MODEL` puts projects inside workspaces and
 * `fk_projects_workspace_tenant` enforces it, so a create-project request needs a
 * `workspaceId` — and until now there was no way for a client to learn one. Provisioning
 * creates exactly one workspace per organization, so in practice this returns a single row;
 * the screen still asks rather than assuming, because an organization gains a second workspace
 * the first time anyone adds one and a client that had hard-coded "the first" would then be
 * silently putting projects in the wrong place.
 *
 * `work.read` rather than `workspace.manage`: this is a list of names a person needs in order
 * to *file* something, not a management surface. `12-PERMISSION-MATRIX` gives `work.read` to
 * every internal role including `guest`, which is the right floor for "what are the parts of
 * this organization called".
 *
 * There is no create, rename or archive route here. Those are `workspace.manage` operations
 * with their own screens (`ADMIN-*`), the repository already supports them, and adding routes
 * with no screen behind them is how an API surface grows faster than anything can exercise it.
 */

export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

const MAX_LIMIT = 200;

@Controller('v1/organizations/:orgSlug/workspaces')
export class WorkspacesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKSPACES_REPOSITORY) private readonly workspaces: WorkspacesRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly workspaces: readonly WorkspaceView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      throw new ApiError(400, 'validation_failed', 'limit must be a positive integer', [
        { field: 'limit', message: 'must be a positive integer' },
      ]);
    }

    const rows = await this.database.read(context, (db) =>
      this.workspaces.list(db, context, {
        ...(after ? { after } : {}),
        ...(parsedLimit === undefined ? {} : { limit: Math.min(parsedLimit, MAX_LIMIT) }),
      }),
    );

    // An explicit projection, for the reason `ProjectView` gives: a column added to
    // `workspaces` later is invisible to every caller until someone decides it should not be.
    // `organization_id` is absent — the caller already named the organization in the path.
    return {
      workspaces: rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}
