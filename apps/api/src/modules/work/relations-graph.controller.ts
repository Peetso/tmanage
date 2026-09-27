import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_RELATIONS_GRAPH_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  DEFAULT_RELATIONS_GRAPH_DEPTH,
  MAX_RELATIONS_GRAPH_DEPTH,
  type WorkRelationsGraphService,
  type WorkRelationsGraphView,
} from './relations-graph.service.js';

/**
 * x274's HTTP surface — the read-only relations graph of a work item (Work module, dependencies).
 *
 * A sub-resource of the work item, like the links list it reads from: the root id is in the path
 * (`:workItemId`), and the service resolves it tenant-scoped and refuses a caller who may not read
 * it with a 404 before any link is read. The capability gate is `work.read`; the row-level decision
 * — may this principal see *this* item and its neighbours — is the service's.
 *
 * `?depth=` bounds the walk to `1..MAX` (default {@link DEFAULT_RELATIONS_GRAPH_DEPTH}); anything
 * else is a 400 here, before the service runs.
 */
@Controller('v1/organizations/:orgSlug/work-items/:workItemId/relations')
export class WorkRelationsGraphController {
  constructor(
    @Inject(WORK_RELATIONS_GRAPH_SERVICE) private readonly graphs: WorkRelationsGraphService,
  ) {}

  @Get('graph')
  @RequireCapability('work.read')
  async graph(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Query('depth') depth?: string,
  ): Promise<WorkRelationsGraphView> {
    return this.graphs.graph(context, principal, workItemId, parseDepth(depth));
  }
}

/**
 * Validate the `depth` query parameter. Absent means the default; anything that is not an integer
 * in `1..MAX` is a 400, so the walk is never asked for an unbounded or nonsensical depth.
 */
function parseDepth(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_RELATIONS_GRAPH_DEPTH;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_RELATIONS_GRAPH_DEPTH) {
    throw new ApiError(400, 'validation_failed', 'depth is invalid', [
      { field: 'depth', message: `must be an integer from 1 to ${MAX_RELATIONS_GRAPH_DEPTH}` },
    ]);
  }
  return value;
}
