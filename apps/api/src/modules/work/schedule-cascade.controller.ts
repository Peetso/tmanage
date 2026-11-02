import {
  Body,
  Controller,
  createParamDecorator,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { isDependencyKind, isDependencyLag } from '@tmanage/domain';
import type { DependencyKind, DependencySource, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  CascadePlanView,
  DependencyEditView,
  ScheduleCascadeService,
} from './schedule-cascade.service.js';

/**
 * 53-04's HTTP surface: edit a typed edge in place, and preview / apply a schedule cascade.
 * Everything is `work.update` on the item named in the path; the service adds `work.update` on
 * every moved item and `project.manage` on each project a cross-project cascade touches.
 */

export const WORK_SCHEDULE_CASCADE_SERVICE = Symbol.for('tmanage.WorkScheduleCascadeService');

/** How the request authenticated (set by `SessionAuthGuard`, never read off the request). */
export const AuthScheme = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    requestState(context.switchToHttp().getRequest())?.authScheme,
);

/** A personal access token is the API; the MCP connector's grant is `mcp`; a cookie is the UI. */
export function dependencySourceOf(authScheme: string | undefined): DependencySource {
  if (authScheme === 'personal_access_token') return 'api';
  if (authScheme === 'ai_grant') return 'mcp';
  return 'ui';
}

/** `kind` (FS|SS|FF|SF) and `lagWorkingDays` (-30..365); absent fields take `fallback`. */
export function parseTypedDependency(
  body: { readonly kind?: unknown; readonly lagWorkingDays?: unknown } | undefined,
  fallback: { readonly kind?: DependencyKind; readonly lag?: number },
): { kind?: DependencyKind; lag?: number } {
  const kind = body?.kind === undefined ? fallback.kind : body.kind;
  const lag = body?.lagWorkingDays === undefined ? fallback.lag : body.lagWorkingDays;
  const details = [];
  if (kind !== undefined && !isDependencyKind(kind)) {
    details.push({ field: 'kind', message: 'must be FS, SS, FF or SF' });
  }
  if (lag !== undefined && !isDependencyLag(lag)) {
    details.push({ field: 'lagWorkingDays', message: 'must be a whole number from -30 to 365' });
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  return {
    ...(kind === undefined ? {} : { kind: kind as DependencyKind }),
    ...(lag === undefined ? {} : { lag: lag as number }),
  };
}

function parseDates(body: { readonly startAt?: unknown; readonly dueAt?: unknown } | undefined): {
  startAt: Date | null;
  dueAt: Date | null;
} {
  const read = (value: unknown): Date | null | undefined => {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? undefined : at;
  };
  const startAt = read(body?.startAt);
  const dueAt = read(body?.dueAt);
  if (startAt === undefined || dueAt === undefined || (startAt && dueAt && startAt > dueAt)) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'startAt', message: 'startAt and dueAt must be ISO dates or null, start ≤ due' },
    ]);
  }
  return { startAt, dueAt };
}

@Controller('v1/organizations/:orgSlug/work-items')
export class ScheduleCascadeController {
  constructor(
    @Inject(WORK_SCHEDULE_CASCADE_SERVICE) private readonly cascades: ScheduleCascadeService,
  ) {}

  @Patch(':workItemId/dependencies/:dependencyId')
  @RequireCapability('work.update')
  async updateDependency(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('dependencyId') dependencyId: string,
    @Body() body: { readonly kind?: unknown; readonly lagWorkingDays?: unknown },
  ): Promise<DependencyEditView> {
    if (body?.kind === undefined && body?.lagWorkingDays === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'kind', message: 'send kind and/or lagWorkingDays' },
      ]);
    }
    const change = parseTypedDependency(body, {});
    return this.cascades.updateDependency(context, principal, workItemId, dependencyId, change);
  }

  @Post(':workItemId/schedule/cascade-preview')
  @RequireCapability('work.update')
  @HttpCode(200)
  async preview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly startAt?: unknown; readonly dueAt?: unknown },
  ): Promise<CascadePlanView> {
    return this.cascades.preview(context, principal, workItemId, parseDates(body));
  }

  @Post(':workItemId/schedule/cascade-apply')
  @RequireCapability('work.update')
  @HttpCode(200)
  async apply(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body()
    body: {
      readonly startAt?: unknown;
      readonly dueAt?: unknown;
      readonly expectedMoves?: unknown;
    },
  ): Promise<CascadePlanView> {
    const expected = body?.expectedMoves;
    if (
      !Array.isArray(expected) ||
      expected.length > 2000 ||
      !expected.every((id) => typeof id === 'string')
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'expectedMoves', message: 'must be the list of item ids the preview returned' },
      ]);
    }
    return this.cascades.apply(context, principal, workItemId, parseDates(body), expected);
  }
}
