import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_RISK_REGISTER_SERVICE } from '../../common/http/tokens.js';
import {
  PROJECT_INTERNAL_RISK_IMPACTS,
  PROJECT_INTERNAL_RISK_LIKELIHOODS,
  PROJECT_INTERNAL_RISK_STATUSES,
} from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ProjectInternalRiskView,
  ProjectRiskRegisterService,
} from './risk-register.service.js';
import type {
  ProjectInternalRiskImpact,
  ProjectInternalRiskLikelihood,
  ProjectInternalRiskStatus,
} from './risk-register.repository.js';

/**
 * PROJ / module 8 (x209). A project's **internal** risk register: log, list, and work a risk.
 *
 * Nested under `…/projects/:projectId/risk-register`, so the project is named in the path and the
 * service resolves it tenant-scoped before it authorizes or writes (Known-trap). Gated on
 * `project.manage` for the writes and `work.read` for the list. Like every tenant-scoped controller
 * here, it never reads `organizationId` from the body, a header, or its own `:orgSlug` segment.
 *
 * This is distinct from x140's `POST/GET …/projects/:projectId/risks` (the clients-module surface that
 * publishes a client-facing risk to a portal): a different path (`risk-register`), a different table
 * (`project_internal_risks`), and internal-only — never projected to a client.
 */

interface CreateRiskBody {
  readonly title?: unknown;
  readonly likelihood?: unknown;
  readonly impact?: unknown;
  readonly mitigation?: unknown;
  readonly status?: unknown;
}

interface PatchRiskBody {
  readonly title?: unknown;
  readonly likelihood?: unknown;
  readonly impact?: unknown;
  readonly mitigation?: unknown;
  readonly status?: unknown;
}

/** `project_internal_risks.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
/** `project_internal_risks.mitigation` is `TEXT`; this is a form field, not a document. */
const MAX_MITIGATION_LENGTH = 20_000;

function isLikelihood(value: unknown): value is ProjectInternalRiskLikelihood {
  return (
    typeof value === 'string' &&
    (PROJECT_INTERNAL_RISK_LIKELIHOODS as readonly string[]).includes(value)
  );
}
function isImpact(value: unknown): value is ProjectInternalRiskImpact {
  return (
    typeof value === 'string' &&
    (PROJECT_INTERNAL_RISK_IMPACTS as readonly string[]).includes(value)
  );
}
function isStatus(value: unknown): value is ProjectInternalRiskStatus {
  return (
    typeof value === 'string' &&
    (PROJECT_INTERNAL_RISK_STATUSES as readonly string[]).includes(value)
  );
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/risk-register')
export class ProjectRiskRegisterController {
  constructor(
    @Inject(PROJECT_RISK_REGISTER_SERVICE) private readonly risks: ProjectRiskRegisterService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly risks: readonly ProjectInternalRiskView[] }> {
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
      risks: await this.risks.list(context, principal, {
        projectId,
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreateRiskBody,
  ): Promise<ProjectInternalRiskView> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }

    const title = typeof body?.title === 'string' ? body.title.trim() : undefined;
    const mitigation =
      typeof body?.mitigation === 'string' && body.mitigation.trim() !== ''
        ? body.mitigation.trim()
        : undefined;

    const details = [
      ...(title ? [] : [{ field: 'title', message: 'must be a non-empty string' }]),
      ...(title && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(isLikelihood(body?.likelihood)
        ? []
        : [
            {
              field: 'likelihood',
              message: `must be one of ${PROJECT_INTERNAL_RISK_LIKELIHOODS.join(', ')}`,
            },
          ]),
      ...(isImpact(body?.impact)
        ? []
        : [
            {
              field: 'impact',
              message: `must be one of ${PROJECT_INTERNAL_RISK_IMPACTS.join(', ')}`,
            },
          ]),
      ...(mitigation && mitigation.length > MAX_MITIGATION_LENGTH
        ? [{ field: 'mitigation', message: `must be ${MAX_MITIGATION_LENGTH} characters or fewer` }]
        : []),
      ...(body?.status !== undefined && !isStatus(body.status)
        ? [
            {
              field: 'status',
              message: `must be one of ${PROJECT_INTERNAL_RISK_STATUSES.join(', ')}`,
            },
          ]
        : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!title || !isLikelihood(body?.likelihood) || !isImpact(body?.impact)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const status: ProjectInternalRiskStatus = isStatus(body?.status) ? body.status : 'open';

    return this.risks.create(context, principal, {
      projectId,
      title,
      likelihood: body.likelihood,
      impact: body.impact,
      ...(mitigation === undefined ? {} : { mitigation }),
      status,
    });
  }

  /**
   * Update a risk's substance: any of `title`, `likelihood`, `impact`, `mitigation`, `status`. At
   * least one field must be present, and any enum given must be valid (unknown ⇒ 400). The
   * tenant/relation resolution and the not-found for an unknown/cross-tenant `riskId` live in the
   * service.
   */
  @Patch(':riskId')
  @RequireCapability('project.manage')
  async patch(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('riskId') riskId: string,
    @Body() body: PatchRiskBody,
  ): Promise<ProjectInternalRiskView> {
    if (typeof riskId !== 'string' || riskId === '') {
      throw new ApiError(400, 'validation_failed', 'riskId is required', [
        { field: 'riskId', message: 'must be a non-empty string' },
      ]);
    }

    const title =
      typeof body?.title === 'string' && body.title.trim() !== '' ? body.title.trim() : undefined;
    const mitigationProvided = body?.mitigation !== undefined;
    const mitigation =
      typeof body?.mitigation === 'string' && body.mitigation.trim() !== ''
        ? body.mitigation.trim()
        : null;

    const details = [
      ...(title !== undefined && title.length > MAX_TITLE_LENGTH
        ? [{ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` }]
        : []),
      ...(body?.likelihood !== undefined && !isLikelihood(body.likelihood)
        ? [
            {
              field: 'likelihood',
              message: `must be one of ${PROJECT_INTERNAL_RISK_LIKELIHOODS.join(', ')}`,
            },
          ]
        : []),
      ...(body?.impact !== undefined && !isImpact(body.impact)
        ? [
            {
              field: 'impact',
              message: `must be one of ${PROJECT_INTERNAL_RISK_IMPACTS.join(', ')}`,
            },
          ]
        : []),
      ...(mitigationProvided && body?.mitigation !== null && typeof body?.mitigation !== 'string'
        ? [{ field: 'mitigation', message: 'must be a string or null' }]
        : []),
      ...(typeof mitigation === 'string' && mitigation.length > MAX_MITIGATION_LENGTH
        ? [{ field: 'mitigation', message: `must be ${MAX_MITIGATION_LENGTH} characters or fewer` }]
        : []),
      ...(body?.status !== undefined && !isStatus(body.status)
        ? [
            {
              field: 'status',
              message: `must be one of ${PROJECT_INTERNAL_RISK_STATUSES.join(', ')}`,
            },
          ]
        : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    const update = {
      ...(title === undefined ? {} : { title }),
      ...(isLikelihood(body?.likelihood) ? { likelihood: body.likelihood } : {}),
      ...(isImpact(body?.impact) ? { impact: body.impact } : {}),
      ...(mitigationProvided ? { mitigation } : {}),
      ...(isStatus(body?.status) ? { status: body.status } : {}),
    };

    if (Object.keys(update).length === 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'body', message: 'at least one field must be provided' },
      ]);
    }

    return this.risks.update(context, principal, riskId, update);
  }
}
