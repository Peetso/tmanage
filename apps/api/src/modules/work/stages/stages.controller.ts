import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../../common/http/decorators.js';
import { ApiError } from '../../../common/http/errors.js';
import { WORK_STAGES_SERVICE } from '../../../common/http/tokens.js';
import type { TenantContext } from '../../../common/database/tenant-context.js';
import type { WorkItemView } from '../work-items.service.js';
import { MAX_STAGES_PER_SET } from './stage-rules.js';
import type {
  EffectiveStageSetView,
  NewStageInput,
  StageSetView,
  WorkStagesService,
} from './stages.service.js';

/**
 * Work area D1 (2026-11-23) — the HTTP surface of stage sets. The decorator is the coarse gate;
 * `WorkStagesService` makes the real decision (org.manage for a workspace set, project.manage on
 * the project for a project's own set, work.update / work.transition on the work) after resolving
 * every id tenant-scoped. Bodies are shape-checked here (400); rules are the service's (422/409).
 *
 * - `GET  work/stage-sets` · `POST work/stage-sets`
 * - `GET | PATCH | DELETE work/stage-sets/:stageSetId`
 * - `POST work/stage-sets/:stageSetId/stages` · `PUT work/stage-sets/:stageSetId/stages/order`
 * - `PATCH | DELETE work/stage-sets/:stageSetId/stages/:stageId`
 * - `GET | PUT projects/:projectId/stage-set`
 * - `PUT work-items/:workItemId/stage` · `PUT work-items/:workItemId/stage-set`
 */

interface StageBody {
  readonly name?: unknown;
  readonly stateKey?: unknown;
  readonly colorKey?: unknown;
  readonly position?: unknown;
}

interface CreateSetBody {
  readonly name?: unknown;
  readonly projectId?: unknown;
  readonly isDefault?: unknown;
  readonly stages?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class WorkStagesController {
  constructor(@Inject(WORK_STAGES_SERVICE) private readonly service: WorkStagesService) {}

  @Get('work/stage-sets')
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly stageSets: readonly StageSetView[] }> {
    return { stageSets: await this.service.listSets(context) };
  }

  @Post('work/stage-sets')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateSetBody,
  ): Promise<StageSetView> {
    const projectId = optionalId(body?.projectId, 'projectId');
    const isDefault = optionalBoolean(body?.isDefault, 'isDefault');
    const stages = optionalStages(body?.stages);
    return this.service.createSet(context, principal, {
      name: body?.name as string,
      ...(projectId === undefined ? {} : { projectId }),
      ...(isDefault === undefined ? {} : { isDefault }),
      ...(stages === undefined ? {} : { stages }),
    });
  }

  @Get('work/stage-sets/:stageSetId')
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @Param('stageSetId') stageSetId: string,
  ): Promise<StageSetView> {
    return this.service.getSet(context, stageSetId);
  }

  @Patch('work/stage-sets/:stageSetId')
  @RequireCapability('project.manage')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('stageSetId') stageSetId: string,
    @Body()
    body: { readonly version?: unknown; readonly name?: unknown; readonly isDefault?: unknown },
  ): Promise<StageSetView> {
    const version = requiredVersion(body?.version);
    const isDefault = optionalBoolean(body?.isDefault, 'isDefault');
    return this.service.updateSet(context, principal, stageSetId, {
      version,
      ...(body?.name === undefined ? {} : { name: body.name as string }),
      ...(isDefault === undefined ? {} : { isDefault }),
    });
  }

  @Delete('work/stage-sets/:stageSetId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('stageSetId') stageSetId: string,
  ): Promise<void> {
    await this.service.deleteSet(context, principal, stageSetId);
  }

  @Post('work/stage-sets/:stageSetId/stages')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async addStage(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('stageSetId') stageSetId: string,
    @Body() body: StageBody,
  ): Promise<StageSetView> {
    return this.service.addStage(context, principal, stageSetId, {
      name: body?.name as string,
      stateKey: body?.stateKey as string,
      ...(body?.colorKey === undefined ? {} : { colorKey: body.colorKey as string | null }),
      ...(body?.position === undefined ? {} : { position: body.position as number }),
    });
  }

  @Put('work/stage-sets/:stageSetId/stages/order')
  @RequireCapability('project.manage')
  async reorder(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('stageSetId') stageSetId: string,
    @Body() body: { readonly stageIds?: unknown },
  ): Promise<StageSetView> {
    const ids = body?.stageIds;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_STAGES_PER_SET ||
      ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 64)
    ) {
      throw invalid('stageIds', `must be a list of at most ${MAX_STAGES_PER_SET} stage ids`);
    }
    return this.service.reorderStages(context, principal, stageSetId, ids as string[]);
  }

  @Patch('work/stage-sets/:stageSetId/stages/:stageId')
  @RequireCapability('project.manage')
  async updateStage(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('stageSetId') stageSetId: string,
    @Param('stageId') stageId: string,
    @Body() body: StageBody,
  ): Promise<StageSetView> {
    if (body?.name === undefined && body?.stateKey === undefined && body?.colorKey === undefined) {
      throw invalid('name', 'give at least one of name, stateKey, colorKey');
    }
    return this.service.updateStage(context, principal, stageSetId, stageId, {
      ...(body?.name === undefined ? {} : { name: body.name as string }),
      ...(body?.stateKey === undefined ? {} : { stateKey: body.stateKey as string }),
      ...(body?.colorKey === undefined ? {} : { colorKey: body.colorKey as string | null }),
    });
  }

  @Delete('work/stage-sets/:stageSetId/stages/:stageId')
  @RequireCapability('project.manage')
  async removeStage(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('stageSetId') stageSetId: string,
    @Param('stageId') stageId: string,
    @Query('moveToStageId') moveToStageId?: string,
  ): Promise<StageSetView> {
    if (moveToStageId !== undefined && (moveToStageId.length === 0 || moveToStageId.length > 64)) {
      throw invalid('moveToStageId', 'must be a stage id');
    }
    return this.service.deleteStage(context, principal, stageSetId, stageId, moveToStageId);
  }

  @Get('projects/:projectId/stage-set')
  @RequireCapability('work.read')
  async projectSet(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<EffectiveStageSetView> {
    return this.service.projectSet(context, principal, projectId);
  }

  @Put('projects/:projectId/stage-set')
  @RequireCapability('project.manage')
  async setProjectSet(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: { readonly stageSetId?: unknown },
  ): Promise<EffectiveStageSetView> {
    return this.service.setProjectSet(context, principal, projectId, nullableId(body?.stageSetId));
  }

  @Put('work-items/:workItemId/stage')
  @RequireCapability('work.update')
  async moveWork(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body()
    body: { readonly stageId?: unknown; readonly version?: unknown; readonly facts?: unknown },
  ): Promise<WorkItemView> {
    const version = requiredVersion(body?.version);
    const stageId = optionalId(body?.stageId, 'stageId');
    if (stageId === undefined) throw invalid('stageId', 'must be a stage id');
    const facts = body?.facts ?? {};
    if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) {
      throw invalid('facts', 'must be an object');
    }
    return this.service.moveWork(context, principal, workItemId, {
      stageId,
      version,
      facts: facts as Record<string, unknown>,
    });
  }

  @Put('work-items/:workItemId/stage-set')
  @RequireCapability('work.update')
  async setWorkSet(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly stageSetId?: unknown; readonly version?: unknown },
  ): Promise<WorkItemView> {
    const version = requiredVersion(body?.version);
    return this.service.setWorkSet(context, principal, workItemId, {
      stageSetId: nullableId(body?.stageSetId),
      version,
    });
  }
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function requiredVersion(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw invalid('version', 'must be the version you last read');
  }
  return raw;
}

function optionalId(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    throw invalid(field, 'must be an id');
  }
  return raw;
}

/** `null` is meaningful (back to the inherited set); absent is not allowed. */
function nullableId(raw: unknown): string | null {
  if (raw === null) return null;
  const id = optionalId(raw, 'stageSetId');
  if (id === undefined) throw invalid('stageSetId', 'must be a stage set id or null');
  return id;
}

function optionalBoolean(raw: unknown, field: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') throw invalid(field, 'must be true or false');
  return raw;
}

function optionalStages(raw: unknown): readonly NewStageInput[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.length > MAX_STAGES_PER_SET ||
    raw.some((stage) => typeof stage !== 'object' || stage === null || Array.isArray(stage))
  ) {
    throw invalid('stages', `must be a list of at most ${MAX_STAGES_PER_SET} stages`);
  }
  return (raw as StageBody[]).map((stage) => ({
    name: stage.name as string,
    stateKey: stage.stateKey as string,
    ...(stage.colorKey === undefined ? {} : { colorKey: stage.colorKey as string | null }),
  }));
}
