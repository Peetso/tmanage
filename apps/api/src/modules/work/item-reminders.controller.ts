import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_ITEM_REMINDERS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  DueReminderView,
  WorkItemReminderView,
  WorkItemRemindersService,
} from './item-reminders.service.js';

/**
 * x256's HTTP surface — a personal reminder on a work item (Work module 7).
 *
 * A sub-resource of the work item, the way `:workItemId/watchers` is: the parent id is in the path,
 * and the service resolves it tenant-scoped before it authorizes or writes. This controller reads
 * no `organizationId` from anywhere — `TenantContextGuard` built the `TenantContext` from a
 * membership row.
 *
 * The gate is `work.read`: a member who may read the item may set a reminder on it. The row-level
 * decision — may this principal see *this* item — is the service's, against the resolved parent. A
 * caller reminds only themselves; there is no route to set anyone else's reminder. `PUT` is an
 * idempotent upsert (the unique key), so a repeat moves `remindAt` and returns the same row;
 * `DELETE` is idempotent too and answers 204 whether or not a reminder was present. The due list is
 * the acting member's own reminders. No notification is dispatched here — email/dispatch is a
 * separate, out-of-scope path.
 *
 * The static `reminders/due` route and the parametric `:workItemId/reminder` routes never collide:
 * the former is two literal segments, the latter is one param segment then the literal `reminder`.
 */

interface SetReminderBody {
  readonly remindAt?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-items')
export class WorkItemRemindersController {
  constructor(
    @Inject(WORK_ITEM_REMINDERS_SERVICE) private readonly reminders: WorkItemRemindersService,
  ) {}

  /** The acting member's reminders due at or before `before` (default: now). Own reminders only. */
  @Get('reminders/due')
  @RequireCapability('work.read')
  async listDue(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('before') before?: string,
  ): Promise<{ readonly reminders: readonly DueReminderView[] }> {
    const bound = before === undefined ? new Date() : parseInstant(before, 'before');
    return { reminders: await this.reminders.listDue(context, principal, bound) };
  }

  /** Set (or move) the acting member's reminder on the item. */
  @Put(':workItemId/reminder')
  @RequireCapability('work.read')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: SetReminderBody,
  ): Promise<WorkItemReminderView> {
    if (typeof body?.remindAt !== 'string' || body.remindAt.trim() === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'remindAt', message: 'must be an ISO-8601 date-time string' },
      ]);
    }
    const remindAt = parseInstant(body.remindAt, 'remindAt');
    return this.reminders.set(context, principal, workItemId, remindAt);
  }

  /** Clear the acting member's reminder on the item. Idempotent. */
  @Delete(':workItemId/reminder')
  @RequireCapability('work.read')
  @HttpCode(204)
  async clear(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<void> {
    await this.reminders.clear(context, principal, workItemId);
  }
}

/**
 * Parse an ISO-8601 instant to a bound `Date`, refusing anything that is not a valid instant with a
 * 400. The value is bound in the app, never the connection's clock, so persistence and the due
 * comparison do not depend on which pool ran the statement.
 */
function parseInstant(value: string, field: string): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new ApiError(400, 'validation_failed', 'The request is invalid', [
      { field, message: 'must be an ISO-8601 date-time string' },
    ]);
  }
  return at;
}
