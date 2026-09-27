import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PORTAL_ACCESS_LOG_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PORTAL_ACCESS_RESOURCE_KINDS } from '../../common/database/schema.js';
import type {
  PortalAccessLogRow,
  PortalAccessResourceKind,
} from '../../common/database/schema.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import {
  PortalAccessLogRepository,
  effectivePageSize,
} from './portal-access-log.repository.js';

/**
 * SEC / Client portal access log (x237) — record what a client accessed, and the internal audit read.
 *
 * The portal read paths (x114 deliverables, CLIENT-003 updates) let a client see published work, but
 * the studio kept no record of *what a client actually looked at*. This slice closes that gap with
 * two halves that never touch a client:
 *
 * - The **record** half is a guarded internal helper ({@link PortalAccessLogService.record}) the
 *   existing portal read handlers call after a successful **client** read. It runs inside
 *   `client_projection.read` paths — it is not a route — and appends one row {project, client
 *   membership, kind, instant}. It records a client access only: an internal preview of the portal
 *   writes nothing.
 * - The **read** half is this controller's one route, behind `project.manage` on the internal
 *   `projects` path. A client role never holds `project.manage`, so `CapabilityGuard` refuses a
 *   client here with 403 before the handler runs; the service resolves the project tenant-scoped and
 *   answers 404 for one this caller cannot manage. **The access log is never projected to a client**
 *   — there is no `/portal` route to it, by design.
 *
 * The recorded rows carry nothing sensitive: a fixed `resource_kind` and a timestamp, never a title,
 * a body or a token.
 */

/** The largest page the audit read returns, mirrored by the web `MAX_PORTAL_ACCESS_PAGE`. */
export const VIEWER_MAX_PAGE_SIZE = 50;

/**
 * One client access event as the internal audit screen is shown it — the wire shape.
 *
 * The wire shape lives here (the file the contracts checker scans and the one that serialises it).
 * It carries no client content: `resourceKind` is a fixed enum and `accessedAt` an instant; `id` is
 * the row's own id (a stable React key), `projectId` the project it names, and `clientMemberId` the
 * client membership that accessed it.
 */
export interface PortalAccessLogView {
  readonly id: string;
  readonly projectId: string;
  readonly clientMemberId: string;
  readonly resourceKind: PortalAccessResourceKind;
  /** An ISO-8601 instant on the wire. */
  readonly accessedAt: string;
}

/** What the internal read handlers ask of the recorder — the seam PortalService depends on. */
export interface PortalAccessRecorder {
  record(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly resourceKind: PortalAccessResourceKind },
  ): Promise<void>;
}

function toView(row: PortalAccessLogRow): PortalAccessLogView {
  return {
    id: row.id,
    projectId: row.projectId,
    clientMemberId: row.clientMemberId,
    resourceKind: row.resourceKind,
    accessedAt: row.accessedAt.toISOString(),
  };
}

function isResourceKind(value: unknown): value is PortalAccessResourceKind {
  return (
    typeof value === 'string' &&
    (PORTAL_ACCESS_RESOURCE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The access-log service — record from a client read, and list for the internal audit screen.
 *
 * Defined here beside the controller rather than in a file of its own because the controller and the
 * portal read handlers are its only callers and the whole slice is one cohesive unit; the unit suite
 * (`portal-access-log.controller.test.ts`) exercises it directly with the real `authorize()` over
 * fakes for the database and the repositories.
 */
export class PortalAccessLogService implements PortalAccessRecorder {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly log: PortalAccessLogRepository = new PortalAccessLogRepository(),
  ) {}

  /**
   * Record one client access event — the guarded internal helper the portal read handlers call.
   *
   * Guarded three ways before any write:
   *
   * 1. **Client only.** An internal principal has no client membership to attribute the access to
   *    (`clientOrganizationId` is null), and an internal preview of the portal is not a client
   *    access — so it writes nothing and returns.
   * 2. **Known vocabulary.** `resourceKind` must be one of the fixed enum; an unknown kind is a
   *    `400`. Callers pass a literal, so this fires only on a bad direct call, but the guard keeps
   *    an unknown kind out of the table at the narrowest point.
   * 3. **May read the project.** The same `client_projection.read` relation the read itself passed
   *    is re-checked here; a principal who could not read the project records nothing (it never
   *    breaks or second-guesses the read — it simply does not log an access that did not happen).
   *
   * The write is its own transaction: recording is a side effect of a read request, not part of it.
   */
  async record(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly resourceKind: PortalAccessResourceKind },
  ): Promise<void> {
    if (!isResourceKind(input.resourceKind)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'resourceKind', message: 'must be a known portal resource kind' },
      ]);
    }

    // Client access only. An internal caller has no client membership to attribute this to.
    if (principal.clientOrganizationId === null) return;
    if (!this.mayRead(principal, input.projectId)) return;

    await this.database.transaction(context, (tx) =>
      this.log.record(tx, context, {
        projectId: input.projectId,
        clientMemberId: principal.membershipId,
        resourceKind: input.resourceKind,
      }),
    );
  }

  /**
   * The internal audit read — one project's client access events, newest first, keyset-paged.
   *
   * The Known-trap order: the route names the project by id, so the project is resolved
   * **tenant-scoped first**. An unknown or cross-tenant `projectId` returns `null` → 404, before any
   * authorize or read. Then the relation check with the project in hand: a caller who cannot manage
   * the project gets 404, never 403 (403 would confirm it exists). The coarse "no `project.manage`
   * at all" refusal is the `CapabilityGuard`'s 403, from the `@RequireCapability` metadata below.
   */
  async listForProject(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly before?: string; readonly limit?: number },
  ): Promise<readonly PortalAccessLogView[]> {
    await this.resolveManageable(context, principal, options.projectId);

    const limit = effectivePageSize(options.limit);
    const rows = await this.database.read(context, (runner) =>
      this.log.list(runner, context, {
        projectId: options.projectId,
        limit,
        ...(options.before ? { before: options.before } : {}),
      }),
    );
    return rows.map(toView);
  }

  /** Resolve the project tenant-scoped, then check the caller may manage it. 404 on either miss. */
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

/**
 * The internal audit surface — `project.manage`, on the `projects` path. A client principal never
 * holds `project.manage`, so `CapabilityGuard` refuses them here with 403 before the handler runs;
 * the service applies the object-level decision (404 for a project they cannot manage). There is no
 * `/portal` route to this data: the access log is internal, never projected to a client.
 */
@Controller('v1/organizations/:orgSlug/projects')
export class PortalAccessLogController {
  constructor(
    @Inject(PORTAL_ACCESS_LOG_SERVICE) private readonly accessLog: PortalAccessLogService,
  ) {}

  @Get(':projectId/portal-access-log')
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): Promise<{ readonly events: readonly PortalAccessLogView[] }> {
    // A bounded list, validated at the boundary: a `limit` outside `[1, 50]`, or one that is not an
    // integer, is a 400 rather than a silent clamp. The service clamps defensively as well.
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (
      parsedLimit !== undefined &&
      (!Number.isSafeInteger(parsedLimit) ||
        parsedLimit < 1 ||
        parsedLimit > VIEWER_MAX_PAGE_SIZE)
    ) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        { field: 'limit', message: `must be an integer between 1 and ${VIEWER_MAX_PAGE_SIZE}` },
      ]);
    }

    return {
      events: await this.accessLog.listForProject(context, principal, {
        projectId,
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
        ...(before ? { before } : {}),
      }),
    };
  }
}
