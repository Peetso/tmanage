import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  PlanChangeRequestsService,
  PlanChangeRequestView,
} from './plan-change-requests.service.js';
import { isPlanId, PLAN_IDS } from './plan-catalog.js';
import type { PlanId } from './plan-catalog.js';

/**
 * Billing & entitlements (module 19, x284). Record an organization's intent to move to another plan.
 * Three routes: create a request, list a tenant's requests, and cancel one. A recorded intent only —
 * nothing here charges, calls a provider, or changes an entitlement.
 *
 * The controller is the HTTP boundary: it validates the request (plan catalog allowlist, effective
 * date today-or-later, note shape) and delegates the tenant-scoping, authorization and one-pending
 * rule to {@link PlanChangeRequestsService}. Every route reuses `org.manage` (owner-only) — no billing
 * capability exists and this slice adds none (the `usage-alerts` slice records the same divergence). An
 * off-catalog `targetPlanCode` or a past `effectiveOn` is a 400 with no write, decided before the
 * service is touched.
 */

/** Maximum length of the optional note — a short free-text explanation, not a document. */
const NOTE_MAX_LENGTH = 2000;

interface CreatePlanChangeRequestBody {
  readonly targetPlanCode?: unknown;
  readonly effectiveOn?: unknown;
  readonly note?: unknown;
}

/**
 * DI token for the service, private to this slice so no `tokens.ts` edit is needed (the `usage-alerts`
 * posture). Exported so `billing.module.ts` can wire the provider, and declared before the controller
 * so its `@Inject` decorator can reference it.
 */
export const PLAN_CHANGE_REQUESTS_SERVICE = Symbol.for('tmanage.PlanChangeRequestsService');

@Controller('v1/organizations/:orgSlug/billing/plan-change-requests')
export class PlanChangeRequestsController {
  constructor(
    @Inject(PLAN_CHANGE_REQUESTS_SERVICE) private readonly requests: PlanChangeRequestsService,
  ) {}

  /** List the acting tenant's plan-change requests, newest-first. `org.manage`. */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly requests: readonly PlanChangeRequestView[] }> {
    return { requests: await this.requests.list(context, principal) };
  }

  /**
   * Create a plan-change request. `org.manage`. An off-catalog target plan or a past effective date is
   * a 400 with no write; a second request while one is pending is a 409.
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreatePlanChangeRequestBody,
  ): Promise<PlanChangeRequestView> {
    const targetPlanCode = validateTargetPlanCode(body?.targetPlanCode);
    const effectiveOn = validateEffectiveOn(body?.effectiveOn);
    const note = validateNote(body?.note);
    return this.requests.create(context, principal, { targetPlanCode, effectiveOn, note });
  }

  /**
   * Cancel a plan-change request. `org.manage`. A cross-tenant or missing id is a 404; the cancel is
   * idempotent (re-cancelling returns the row unchanged).
   */
  @Put(':id/cancel')
  @RequireCapability('org.manage')
  async cancel(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<PlanChangeRequestView> {
    requireId(id);
    return this.requests.cancel(context, principal, id);
  }
}

function validateTargetPlanCode(raw: unknown): PlanId {
  if (!isPlanId(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'targetPlanCode', message: `must be one of ${PLAN_IDS.join(', ')}` }],
      'plan_change_request_target_off_catalog',
    );
  }
  return raw;
}

/**
 * A calendar date (`YYYY-MM-DD`) that is today or later, compared in UTC. The lexical order of an
 * `YYYY-MM-DD` string matches its chronological order, so a string compare against today's UTC date is
 * exact and deterministic. A malformed or non-existent date, or one in the past, is a 400 with no write.
 */
function validateEffectiveOn(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'effectiveOn', message: 'must be a date in YYYY-MM-DD form' }],
      'plan_change_request_effective_on_malformed',
    );
  }
  // Reject a well-formed but non-existent date (e.g. 2026-02-30): the round-trip through UTC must
  // reproduce the same string.
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'effectiveOn', message: 'must be a real calendar date' }],
      'plan_change_request_effective_on_malformed',
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  if (raw < today) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request body is invalid',
      [{ field: 'effectiveOn', message: 'must be today or a future date' }],
      'plan_change_request_effective_on_past',
    );
  }
  return raw;
}

function validateNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: 'must be a string' },
    ]);
  }
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.length > NOTE_MAX_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: `must be at most ${NOTE_MAX_LENGTH} characters` },
    ]);
  }
  return trimmed;
}

function requireId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new ApiError(400, 'validation_failed', 'id is required', [
      { field: 'id', message: 'must be a non-empty string' },
    ]);
  }
}
