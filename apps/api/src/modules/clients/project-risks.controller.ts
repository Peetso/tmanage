import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PROJECT_RISKS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import {
  ProjectRisksRepository,
  effectivePageSize as riskPageSize,
} from './project-risks.repository.js';
import type { ProjectRiskSeverity, ProjectRiskStatus } from './project-risks.repository.js';
import {
  isProjectRiskSeverity,
  isProjectRiskStatus,
  toClientRiskView,
  toProjectRiskView,
} from './project-risks.projection.js';

/**
 * SEC / Portal risks (x140) — the internal write/read surface and the client projection.
 *
 * The design mirrors CLIENT-003 (project_updates, x125) and portal milestones (x139) exactly, and
 * for the same reasons:
 *
 * - The **internal** routes (`POST`/`GET projects/:projectId/risks`) live on the internal `projects`
 *   path behind `project.manage`, which no client role holds. Keeping the write and the full read
 *   off `/portal` means a client principal never reaches them — a security property, not a routing
 *   preference. The full read carries the `internalNote`, the substance a client must never see.
 * - The **client** route (`GET portal/projects/:projectId/risks`) is on a path of its own and serves
 *   the client projection ({@link ClientRiskView}) — client summary, severity and status only, never
 *   the title, internal note, author or publish flag — from a query that only ever selects
 *   `published = 1`.
 *
 * The two controllers share one {@link ProjectRisksService}: the project is resolved tenant-scoped
 * and relation-checked there, and the risk store reads or appends against it.
 */

/** `project_risks.title` is VARCHAR(300). */
const MAX_RISK_TITLE_LENGTH = 300;
/** `project_risks.client_summary` is VARCHAR(2000). */
const MAX_RISK_CLIENT_SUMMARY_LENGTH = 2000;
/** `project_risks.internal_note` is TEXT; cap the accepted length so a body cannot be unbounded. */
const MAX_RISK_INTERNAL_NOTE_LENGTH = 5000;

/**
 * A risk as an **internal** principal is shown it — the full record behind `project.manage`.
 *
 * The wire shape lives here (the file the contracts checker scans and the one that serialises it);
 * `project-risks.projection.ts` maps a row onto it. Carries the internal substance a client must
 * never see: `title` (the staff-facing handle), `internalNote` (the detail behind the risk),
 * `createdByUserId` (who recorded it) and `published` (whether it has reached the client). This view
 * never leaves the internal `projects` path.
 */
export interface ProjectRiskView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly severity: ProjectRiskSeverity;
  readonly status: ProjectRiskStatus;
  /** The internal-only detail. Nullable. Never present on {@link ClientRiskView}. */
  readonly internalNote: string | null;
  /** The client-facing description — the same text the client projection carries. */
  readonly clientSummary: string;
  readonly published: boolean;
  readonly createdByUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/**
 * A risk as a **client** is shown it — the client projection.
 *
 * What is absent is the point, and it is the whole slice. **`title` and `internalNote` are not here**
 * — they are the internal substance (12-PERMISSION-MATRIX §4 gives the client "published risk", the
 * client-facing summary, never the internal note). **`createdByUserId` is not here** — §4 excludes
 * staff, so which member of the agency recorded the risk is never learned. **`published` is not here
 * either**: a client only ever receives published risks (the read filters `published = 1`), so the
 * flag would be a constant `true` that leaks the existence of the draft concept. The client is shown
 * the client summary, the severity and the status — and nothing else.
 */
export interface ClientRiskView {
  readonly id: string;
  readonly projectId: string;
  readonly severity: ProjectRiskSeverity;
  readonly status: ProjectRiskStatus;
  readonly clientSummary: string;
  readonly createdAt: string;
}

/** What an internal principal records. The tenant and the author come from the context, never the body. */
export interface CreateRiskCommand {
  readonly projectId: string;
  readonly title: string;
  readonly severity: ProjectRiskSeverity;
  readonly status: ProjectRiskStatus;
  readonly internalNote: string | null;
  readonly clientSummary: string;
  readonly published: boolean;
}

/**
 * The risks service — resolve the project tenant-scoped, authorize, then read or write.
 *
 * It is defined here beside the controllers rather than in a file of its own because the two
 * controllers are its only callers and the whole slice is one cohesive unit; the unit suite
 * (`project-risks.controller.test.ts`) exercises it directly with the real `authorize()` over fakes
 * for the database and the repositories.
 */
export class ProjectRisksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly risks: ProjectRisksRepository = new ProjectRisksRepository(),
  ) {}

  /**
   * Record a risk — the internal half. `project.manage`, internal only.
   *
   * The Known-trap order (FAST-PROTOCOL 19:55): the route names the project by id, so the project is
   * resolved **tenant-scoped first** ({@link ProjectsRepository.findById}). An unknown or
   * cross-tenant `projectId` returns `null` → 404, **before** any authorize or write — without it an
   * org-wide caller would drive the id into the composite foreign key, a 500 rather than a
   * not-found. Then the relation check with the project in hand: a caller who cannot manage the
   * project gets 404, never 403 (403 would confirm it exists). The author is `context.userId`, never
   * a body field.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: CreateRiskCommand,
  ): Promise<ProjectRiskView> {
    await this.resolveManageable(context, principal, input.projectId);

    const row = await this.database.transaction(context, (tx) =>
      this.risks.create(tx, context, {
        projectId: input.projectId,
        title: input.title,
        severity: input.severity,
        status: input.status,
        internalNote: input.internalNote,
        clientSummary: input.clientSummary,
        published: input.published,
        createdByUserId: context.userId,
      }),
    );

    return toProjectRiskView(row);
  }

  /** The full internal list for one project — `project.manage`, internal only. Carries `internalNote`. */
  async listInternal(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ProjectRiskView[]> {
    await this.resolveManageable(context, principal, projectId);

    const limit = riskPageSize(undefined);
    const rows = await this.database.read(context, (runner) =>
      this.risks.list(runner, context, { projectId, publishedOnly: false, limit }),
    );
    return rows.map(toProjectRiskView);
  }

  /**
   * The published risks for one project this client may read — the client half.
   *
   * {@link mayRead} runs `authorize()` rule 10 for a client — the project must be in
   * `principal.projectIds`, which comes from `project_clients` and nothing else — and an unknown,
   * cross-tenant or sibling-client `projectId` fails it. The refusal is **404, not 403**: a client
   * probing project ids must not learn which of them are real.
   *
   * `published = 1` is a **query predicate**, not a `.filter()` afterwards, so an unpublished risk is
   * never in the result set; and {@link toClientRiskView} carries no title, internal note or staff
   * identity, so even the published rows leak nothing internal.
   */
  async listForClient(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ClientRiskView[]> {
    if (!this.mayRead(principal, projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const limit = riskPageSize(undefined);
    const rows = await this.database.read(context, (runner) =>
      this.risks.list(runner, context, { projectId, publishedOnly: true, limit }),
    );
    return rows.map(toClientRiskView);
  }

  /**
   * Resolve the project tenant-scoped, then check the caller may manage it. Throws 404 on either
   * miss, so a caller can tell neither which projects exist nor which they are barred from.
   */
  private async resolveManageable(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

  /** May this principal read the client projection of this project? `authorize()` rules 7-10. */
  private mayRead(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/** Shared body parsing for the create route. Throws `validation_failed` with field details. */
function parseCreateBody(projectId: string, body: unknown): CreateRiskCommand {
  const record = (body ?? {}) as Record<string, unknown>;
  const details: { field: string; message: string }[] = [];

  const rawTitle = record['title'];
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : undefined;
  if (!title) {
    details.push({ field: 'title', message: 'must be a non-empty string' });
  } else if (title.length > MAX_RISK_TITLE_LENGTH) {
    details.push({
      field: 'title',
      message: `must be ${MAX_RISK_TITLE_LENGTH} characters or fewer`,
    });
  }

  const rawClientSummary = record['clientSummary'];
  const clientSummary = typeof rawClientSummary === 'string' ? rawClientSummary.trim() : undefined;
  if (!clientSummary) {
    details.push({ field: 'clientSummary', message: 'must be a non-empty string' });
  } else if (clientSummary.length > MAX_RISK_CLIENT_SUMMARY_LENGTH) {
    details.push({
      field: 'clientSummary',
      message: `must be ${MAX_RISK_CLIENT_SUMMARY_LENGTH} characters or fewer`,
    });
  }

  // Optional. When present it must be a string within the cap; absent or empty is stored as null.
  const rawInternalNote = record['internalNote'];
  let internalNote: string | null = null;
  if (rawInternalNote !== undefined && rawInternalNote !== null) {
    if (typeof rawInternalNote === 'string') {
      const trimmed = rawInternalNote.trim();
      if (trimmed.length > MAX_RISK_INTERNAL_NOTE_LENGTH) {
        details.push({
          field: 'internalNote',
          message: `must be ${MAX_RISK_INTERNAL_NOTE_LENGTH} characters or fewer`,
        });
      } else {
        internalNote = trimmed === '' ? null : trimmed;
      }
    } else {
      details.push({ field: 'internalNote', message: 'must be a string or null' });
    }
  }

  // Defaults to 'medium' — a risk is recorded at a middling severity until judged otherwise.
  const rawSeverity = record['severity'];
  let severity: ProjectRiskSeverity = 'medium';
  if (rawSeverity !== undefined) {
    if (isProjectRiskSeverity(rawSeverity)) {
      severity = rawSeverity;
    } else {
      details.push({ field: 'severity', message: 'must be one of low, medium, high' });
    }
  }

  // Defaults to 'open' — a risk is open when first recorded.
  const rawStatus = record['status'];
  let status: ProjectRiskStatus = 'open';
  if (rawStatus !== undefined) {
    if (isProjectRiskStatus(rawStatus)) {
      status = rawStatus;
    } else {
      details.push({ field: 'status', message: 'must be one of open, mitigated, closed' });
    }
  }

  const rawPublished = record['published'];
  if (rawPublished !== undefined && typeof rawPublished !== 'boolean') {
    details.push({ field: 'published', message: 'must be a boolean' });
  }
  // Defaults to true — a risk recorded on the portal surface is meant to be seen; a draft is the
  // explicit opt-out (`published: false`). The publish/unpublish lifecycle is a later slice.
  const published = rawPublished === undefined ? true : (rawPublished as boolean);

  if (details.length > 0 || !title || !clientSummary) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }

  return { projectId, title, severity, status, internalNote, clientSummary, published };
}

/**
 * The internal risks surface — `project.manage`, on the `projects` path. A client principal never
 * holds `project.manage`, so `CapabilityGuard` refuses them here with 403 before the handler runs;
 * the service applies the object-level decision (404 for a project they cannot manage). The list
 * carries the internal note, so it never leaves this path.
 */
@Controller('v1/organizations/:orgSlug/projects')
export class ProjectRisksController {
  constructor(@Inject(PROJECT_RISKS_SERVICE) private readonly risks: ProjectRisksService) {}

  @Post(':projectId/risks')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<ProjectRiskView> {
    return this.risks.create(context, principal, parseCreateBody(projectId, body));
  }

  @Get(':projectId/risks')
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly risks: readonly ProjectRiskView[] }> {
    return { risks: await this.risks.listInternal(context, principal, projectId) };
  }
}

/**
 * The client risks projection — `client_projection.read`, on the `/portal` path. Published only, no
 * title, no internal note, no staff identity; 404 (not 403, not an empty list) for a project this
 * client cannot read.
 */
@Controller('v1/organizations/:orgSlug/portal')
export class PortalRisksController {
  constructor(@Inject(PROJECT_RISKS_SERVICE) private readonly risks: ProjectRisksService) {}

  @Get('projects/:projectId/risks')
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly risks: readonly ClientRiskView[] }> {
    return { risks: await this.risks.listForClient(context, principal, projectId) };
  }
}
