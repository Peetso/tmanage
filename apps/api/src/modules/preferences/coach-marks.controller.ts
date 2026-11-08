import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { COACH_MARK_OUTCOMES, COACH_MARK_TOURS } from './coach-marks.repository.js';
import type {
  CoachMarkOutcome,
  CoachMarksRepository,
  CoachMarksState,
  CoachMarkTour,
} from './coach-marks.repository.js';

export const COACH_MARKS_REPOSITORY = Symbol.for('tmanage.CoachMarksRepository');

/** The wire shape: which tours have ended, and whether the member turned tours off. */
export interface CoachMarksView {
  readonly tours: Readonly<Record<CoachMarkTour, CoachMarkOutcome | null>>;
  readonly neverAgain: boolean;
}

/**
 * Row 55-09 first-visit tours — the caller's own "seen / skipped / never again" state. No
 * membership in the path: the subject is always the authenticated membership, so nobody can read
 * or write another member's state. Behind `work.read` like the sibling own-preference routes, so a
 * client principal is refused before a handler runs.
 */
@Controller('v1/organizations/:orgSlug/me/coach-marks')
export class CoachMarksController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(COACH_MARKS_REPOSITORY) private readonly store: CoachMarksRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CoachMarksView> {
    const state = await this.database.read(context, (runner) =>
      this.store.read(runner, context, principal.membershipId),
    );
    return viewOf(state);
  }

  /**
   * Record how one tour ended (`tour` + `outcome`) and/or the "never again" choice. Only the named
   * keys are merged, so the other tours keep their state.
   */
  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<CoachMarksView> {
    const patch = parsePatch(body);
    return this.database.transaction(context, async (tx) => {
      await this.store.merge(tx, context, principal.membershipId, patch);
      return viewOf(await this.store.read(tx, context, principal.membershipId));
    });
  }
}

/** A total projection: unknown stored keys never leak, odd stored values read as "not seen". */
export function viewOf(state: CoachMarksState): CoachMarksView {
  const outcome = (value: unknown): CoachMarkOutcome | null =>
    (COACH_MARK_OUTCOMES as readonly unknown[]).includes(value)
      ? (value as CoachMarkOutcome)
      : null;
  return {
    tours: {
      my_day: outcome(state.my_day),
      projects: outcome(state.projects),
      work_board: outcome(state.work_board),
    },
    neverAgain: state.neverAgain === true,
  };
}

function parsePatch(body: unknown): CoachMarksState {
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];
  const patch: Record<string, unknown> = {};
  const hasTour = value['tour'] !== undefined || value['outcome'] !== undefined;
  if (hasTour) {
    const tour = value['tour'];
    const outcome = value['outcome'];
    if (!(COACH_MARK_TOURS as readonly unknown[]).includes(tour)) {
      details.push({ field: 'tour', message: `must be one of ${COACH_MARK_TOURS.join(', ')}` });
    }
    if (!(COACH_MARK_OUTCOMES as readonly unknown[]).includes(outcome)) {
      details.push({
        field: 'outcome',
        message: `must be one of ${COACH_MARK_OUTCOMES.join(', ')}`,
      });
    }
    patch[tour as string] = outcome;
  }
  if (value['neverAgain'] !== undefined) {
    if (typeof value['neverAgain'] !== 'boolean') {
      details.push({ field: 'neverAgain', message: 'must be a boolean' });
    }
    patch['neverAgain'] = value['neverAgain'];
  }
  if (!hasTour && value['neverAgain'] === undefined) {
    details.push({ field: 'tour', message: 'name a tour or neverAgain' });
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  return patch as CoachMarksState;
}
