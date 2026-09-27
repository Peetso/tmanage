import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { FocusBlocksService, FocusBlockView } from './focus-blocks.service.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

/** DI token for the focus-blocks service, owned by this slice (registered in `calendar.module.ts`). */
export const FOCUS_BLOCKS_SERVICE = Symbol.for('tmanage.FocusBlocksService');

/**
 * CAL-04 "Focus block" (x255) — a member's own protected time on the calendar: create a block, list
 * the caller's blocks in a bounded window, delete one. Like every tenant-scoped controller here it
 * never reads `organizationId` (or the acting membership) from the body, a header, or its `:orgSlug`
 * segment: it receives the `TenantContext` that `TenantContextGuard` built from a membership row and
 * passes it on, and the subject membership is always the authenticated principal's own. Every route is
 * `work.read` — the personal-calendar capability the sibling own-principal slices (quiet-hours x215,
 * widget-prefs x243) reuse, since the permission matrix names none and the pass forbids inventing one.
 *
 * Validation lives here, not in the store: a malformed body — an unparseable time, `endsAt <= startsAt`,
 * a duration over the 24h cap, an empty or over-long title — is the client's error to be told about
 * (400), never a state the store should hold, so nothing is written when it is rejected.
 */

/** The longest a single focus block may span. A block is protected time, not a multi-day hold. */
const MAX_BLOCK_MS = 24 * 60 * 60 * 1000;

/** The widest window a list request may ask for, so a query can never scan an unbounded range. */
const MAX_LIST_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/** The longest a block title may be, matching the `varchar(200)` column. */
const MAX_TITLE_LENGTH = 200;

@Controller('v1/organizations/:orgSlug/calendar/focus-blocks')
export class FocusBlocksController {
  constructor(@Inject(FOCUS_BLOCKS_SERVICE) private readonly blocks: FocusBlocksService) {}

  /** List the caller's focus blocks that start within `[from, to)`. Both bounds required. */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ readonly blocks: readonly FocusBlockView[] }> {
    const details: { field: string; message: string }[] = [];
    const fromInstant = parseInstant('from', from, details);
    const toInstant = parseInstant('to', to, details);
    if (fromInstant && toInstant) {
      if (toInstant.getTime() <= fromInstant.getTime()) {
        details.push({ field: 'to', message: 'must be after from' });
      } else if (toInstant.getTime() - fromInstant.getTime() > MAX_LIST_WINDOW_MS) {
        details.push({ field: 'to', message: 'the window must span 366 days or fewer' });
      }
    }
    if (details.length > 0 || !fromInstant || !toInstant) {
      throw new ApiError(400, 'validation_failed', 'The date range is invalid', details);
    }
    return { blocks: await this.blocks.list(context, principal, fromInstant, toInstant) };
  }

  /** Create a focus block for the caller. Returns the stored block (201). */
  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<FocusBlockView> {
    const input = parseCreate(body);
    return this.blocks.create(context, principal, input);
  }

  /** Delete one of the caller's focus blocks. A block that is not the caller's own is a 404 (204 on success). */
  @Delete(':id')
  @RequireCapability('work.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    if (typeof id !== 'string' || id === '') {
      throw new ApiError(400, 'validation_failed', 'id is required', [
        { field: 'id', message: 'must be a non-empty string' },
      ]);
    }
    await this.blocks.remove(context, principal, id);
  }
}

/** Parse an ISO-8601 instant query value, recording a validation detail rather than throwing. */
function parseInstant(
  field: string,
  raw: string | undefined,
  details: { field: string; message: string }[],
): Date | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    details.push({ field, message: 'is required' });
    return null;
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    details.push({ field, message: 'must be an ISO-8601 instant' });
    return null;
  }
  return new Date(ms);
}

/**
 * Validate a create body into a well-formed {@link CreateFocusBlock}. `startsAt`/`endsAt` are ISO-8601
 * instants, `endsAt` strictly after `startsAt`, the span at most 24h; `title` is a non-empty string of
 * at most 200 characters. Any violation is a 400 and nothing is written.
 */
function parseCreate(body: unknown): { startsAt: Date; endsAt: Date; title: string } {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const instant = (field: string): Date | null => {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.length === 0) {
      details.push({ field, message: 'must be an ISO-8601 instant' });
      return null;
    }
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) {
      details.push({ field, message: 'must be an ISO-8601 instant' });
      return null;
    }
    return new Date(ms);
  };
  const startsAt = instant('startsAt');
  const endsAt = instant('endsAt');

  if (startsAt && endsAt) {
    if (endsAt.getTime() <= startsAt.getTime()) {
      details.push({ field: 'endsAt', message: 'must be after startsAt' });
    } else if (endsAt.getTime() - startsAt.getTime() > MAX_BLOCK_MS) {
      details.push({ field: 'endsAt', message: 'a focus block may span at most 24 hours' });
    }
  }

  const titleRaw = value['title'];
  let title = '';
  if (typeof titleRaw !== 'string' || titleRaw.trim().length === 0) {
    details.push({ field: 'title', message: 'must be a non-empty string' });
  } else if (titleRaw.length > MAX_TITLE_LENGTH) {
    details.push({ field: 'title', message: 'must be at most 200 characters' });
  } else {
    title = titleRaw.trim();
  }

  if (details.length > 0 || !startsAt || !endsAt) {
    throw new ApiError(400, 'validation_failed', 'The focus block is invalid', details);
  }

  return { startsAt, endsAt, title };
}
