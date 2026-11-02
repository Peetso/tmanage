import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import { QUICK_ADD_MAX_QUERY } from './quick-add.service.js';
import type { QuickAddResolveView, QuickAddService } from './quick-add.service.js';

/**
 * 55-25 — quick-add, Arabic + English: `GET …/work/quick-add/resolve?q=&projectId=`.
 *
 * Capabilities (no `capabilities.ts` edit): resolving is `work.read` — candidates are only the
 * people the caller may already list in the directory and the projects they may read. Creating the
 * item is the existing `POST …/work-items` (`work.create`), unchanged: the client sends the
 * structured fields the chips resolved to.
 *
 * `q` is at most 300 characters (else 400). 60 requests a minute per caller address
 * (`@Throttle`: the durable limiter runs before the session is read, so the address is the key it
 * has; behind a session that is one person's browser). A read: no audit.
 */

export const WORK_QUICK_ADD_SERVICE = Symbol.for('tmanage.WorkQuickAddService');

export const QUICK_ADD_RESOLVE_LIMITS = {
  perMinute: 60,
  key: 'ip',
  onStoreError: 'open',
} as const;

const MAX_ID_LENGTH = 64;

@Controller('v1/organizations/:orgSlug/work/quick-add')
export class WorkQuickAddController {
  constructor(@Inject(WORK_QUICK_ADD_SERVICE) private readonly quickAdd: QuickAddService) {}

  @Get('resolve')
  @RequireCapability('work.read')
  @Throttle('work_quick_add_resolve', QUICK_ADD_RESOLVE_LIMITS)
  resolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('q') q: unknown,
    @Query('projectId') projectId: unknown,
  ): Promise<QuickAddResolveView> {
    const details: { field: string; message: string }[] = [];
    if (typeof q !== 'string') details.push({ field: 'q', message: 'must be a string' });
    else if (q.length > QUICK_ADD_MAX_QUERY) {
      details.push({ field: 'q', message: `must be ${QUICK_ADD_MAX_QUERY} characters or fewer` });
    }
    const project = projectId === undefined || projectId === '' ? null : projectId;
    if (project !== null && (typeof project !== 'string' || project.length > MAX_ID_LENGTH)) {
      details.push({ field: 'projectId', message: 'must be a project id' });
    }
    if (details.length > 0 || typeof q !== 'string') {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', details);
    }
    return this.quickAdd.resolve(context, principal, q, project as string | null);
  }
}
