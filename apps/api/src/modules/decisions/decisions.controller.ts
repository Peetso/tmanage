import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DECISIONS_SERVICE } from '../../common/http/tokens.js';
import { DECISION_STATUSES } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DecisionDetailView, DecisionView, DecisionsService } from './decisions.service.js';
import type { DecisionStatus } from './decisions.repository.js';

/**
 * DEC-01 (x113). The decision-register endpoints: author a decision, and list a project's register.
 *
 * Gated on `meeting.write` / `meeting.read` — the register reuses the calendar's capabilities this
 * slice (no dedicated `decision.*`; a Needs-Peter). Like every tenant-scoped controller here, it
 * never reads `organizationId` from the body, a header, or its own `:orgSlug` segment: it receives
 * the `TenantContext` that `TenantContextGuard` built from a membership row and passes it on.
 */

interface CreateDecisionBody {
  readonly projectId?: unknown;
  readonly meetingId?: unknown;
  readonly title?: unknown;
  readonly statement?: unknown;
  readonly status?: unknown;
  /** An ISO-8601 instant, e.g. `2026-10-01T14:00:00.000Z`. Optional; defaults to now. */
  readonly decidedAt?: unknown;
}

/** `decisions.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
/** `decisions.statement` is `TEXT`; this is a form field, not a document. */
const MAX_STATEMENT_LENGTH = 20_000;

function isDecisionStatus(value: unknown): value is DecisionStatus {
  return typeof value === 'string' && (DECISION_STATUSES as readonly string[]).includes(value);
}

@Controller('v1/organizations/:orgSlug/decisions')
export class DecisionsController {
  constructor(@Inject(DECISIONS_SERVICE) private readonly decisions: DecisionsService) {}

  @Get()
  @RequireCapability('meeting.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly decisions: readonly DecisionView[] }> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      decisions: await this.decisions.list(context, principal, {
        projectId,
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateDecisionBody,
  ): Promise<DecisionView> {
    const projectId = typeof body?.projectId === 'string' ? body.projectId : undefined;
    const meetingId =
      typeof body?.meetingId === 'string' && body.meetingId !== '' ? body.meetingId : undefined;
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const statement = typeof body?.statement === 'string' ? body.statement.trim() : undefined;

    const details = [
      ...(projectId ? [] : [{ field: 'projectId', message: 'must be a non-empty string' }]),
      ...(title ? [] : [{ field: 'title', message: 'must be a non-empty string' }]),
      ...(title && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(statement ? [] : [{ field: 'statement', message: 'must be a non-empty string' }]),
      ...(statement && statement.length > MAX_STATEMENT_LENGTH
        ? [{ field: 'statement', message: `must be ${MAX_STATEMENT_LENGTH} characters or fewer` }]
        : []),
      ...(body?.status !== undefined && !isDecisionStatus(body.status)
        ? [
            {
              field: 'status',
              message: `must be one of ${DECISION_STATUSES.join(', ')}`,
            },
          ]
        : []),
    ];

    const decidedAt = parseInstant(body?.decidedAt, details);

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!projectId || !title || !statement || !decidedAt) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const status: DecisionStatus = isDecisionStatus(body?.status) ? body.status : 'proposed';

    return this.decisions.create(context, principal, {
      projectId,
      ...(meetingId === undefined ? {} : { meetingId }),
      title,
      statement,
      status,
      decidedAt,
    });
  }

  /**
   * DEC-02 (x117). One decision's detail, including its supersede chain. Gated on `meeting.read`;
   * the relation gate and the not-found for an unknown/cross-tenant/non-member id are the service's.
   */
  @Get(':decisionId')
  @RequireCapability('meeting.read')
  async detail(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
  ): Promise<DecisionDetailView> {
    if (typeof decisionId !== 'string' || decisionId === '') {
      throw new ApiError(400, 'validation_failed', 'decisionId is required', [
        { field: 'decisionId', message: 'must be a non-empty string' },
      ]);
    }
    return this.decisions.detail(context, principal, decisionId);
  }

  /**
   * DEC-01-b (x117). Move a decision through its lifecycle. This slice supports one transition,
   * `proposed → accepted`, so the body's only accepted `status` is `accepted`; the guarded state
   * machine (an illegal transition is a 409 with no write) lives in the service.
   */
  @Patch(':decisionId')
  @RequireCapability('meeting.write')
  async patch(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
    @Body() body: PatchDecisionBody,
  ): Promise<DecisionView> {
    if (typeof decisionId !== 'string' || decisionId === '') {
      throw new ApiError(400, 'validation_failed', 'decisionId is required', [
        { field: 'decisionId', message: 'must be a non-empty string' },
      ]);
    }
    if (body?.status !== 'accepted') {
      throw new ApiError(422, 'validation_failed', 'Only accepting a decision is supported', [
        { field: 'status', message: "must be 'accepted'" },
      ]);
    }
    return this.decisions.accept(context, principal, decisionId);
  }

  /**
   * DEC-01-b / DEC-02 (x117). Supersede a decision by another decision, recording the chain edge and
   * flipping the superseded decision's status in one transaction. Gated on `meeting.write`; the
   * tenant/project resolution of both ids, the self- and already-superseded checks, and the not-found
   * for an unknown/cross-tenant/cross-project superseding id are the service's.
   */
  @Post(':decisionId/supersede')
  @HttpCode(200)
  @RequireCapability('meeting.write')
  async supersede(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
    @Body() body: SupersedeDecisionBody,
  ): Promise<DecisionDetailView> {
    if (typeof decisionId !== 'string' || decisionId === '') {
      throw new ApiError(400, 'validation_failed', 'decisionId is required', [
        { field: 'decisionId', message: 'must be a non-empty string' },
      ]);
    }
    const supersededById =
      typeof body?.supersededById === 'string' && body.supersededById !== ''
        ? body.supersededById
        : undefined;
    if (supersededById === undefined) {
      throw new ApiError(400, 'validation_failed', 'supersededById is required', [
        { field: 'supersededById', message: 'must be a non-empty string' },
      ]);
    }
    return this.decisions.supersede(context, principal, decisionId, supersededById);
  }
}

interface PatchDecisionBody {
  readonly status?: unknown;
}

interface SupersedeDecisionBody {
  readonly supersededById?: unknown;
}

/**
 * Validate an optional ISO-8601 instant and return it as a `Date`, defaulting to now when absent.
 *
 * A decision's `decidedAt` is a point in time, stored as a UTC instant. An absent value defaults to
 * the current instant (the decision is being recorded now); a present-but-unparseable value is a
 * field error.
 */
function parseInstant(
  raw: unknown,
  details: { field: string; message: string }[],
): Date | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return new Date();
  }
  if (typeof raw !== 'string') {
    details.push({ field: 'decidedAt', message: 'must be an ISO-8601 date-time string' });
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field: 'decidedAt', message: 'must be an ISO-8601 date-time string' });
    return undefined;
  }
  return parsed;
}
