import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DecisionsRepository } from './decisions.repository.js';
import type { CreateDecisionInput } from './decisions.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { MeetingsRepository } from '../calendar/meetings.repository.js';
import type { DecisionRow } from '../../common/database/schema.js';
import type { DecisionStatus } from './decisions.repository.js';

/**
 * The application service for DEC-01 (x113) — the decision register's object-level decisions the
 * route guard cannot make. It follows the `MeetingsService` shape.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse question `meeting.read` / `meeting.write`: does
 * this role's ceiling include the capability at all. This service adds the **relation** check with
 * the row's project in hand — an internal member without organization-wide scope reads and writes
 * only the projects they belong to.
 *
 * That relation check is expressed with the sibling `work.read` / `work.create` capabilities rather
 * than with `meeting.*`, exactly as `MeetingsService` does and for the same reason: `meeting.read`
 * was declared a ceiling-mirror of `work.read` and `meeting.write` of `work.create` (see
 * `packages/domain/src/policies/capabilities.ts`), so the two are equal by construction for every
 * role, and `work.*` is what `authorize()` already relation-gates. The register reuses `meeting.*`
 * at the route this slice (no dedicated `decision.*` capability — that is a Needs-Peter), so its
 * relation gate reuses the same `work.*` mapping the calendar does.
 *
 * No audit event is written yet — like `MeetingsService`, the audit action for a decision is a
 * follow-up (it needs a `decision.*` entry in the `AuditAction` catalog, out of this slice's scope).
 */

/** What a caller is allowed to see of a decision. `organizationId` is deliberately absent. */
export interface DecisionView {
  readonly id: string;
  readonly projectId: string;
  readonly meetingId: string | null;
  readonly title: string;
  readonly statement: string;
  readonly status: DecisionStatus;
  readonly decidedBy: string;
  /** An ISO-8601 instant on the wire. */
  readonly decidedAt: string;
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `decisions` in a future migration is invisible to every caller
 * until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: DecisionRow): DecisionView {
  return {
    id: row.id,
    projectId: row.projectId,
    meetingId: row.meetingId,
    title: row.title,
    statement: row.statement,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export class DecisionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly decisions: DecisionsRepository = new DecisionsRepository(),
    /**
     * Read-only, used to prove the project a new decision names exists **inside this tenant**
     * before the insert is attempted, exactly as `MeetingsService` does. The composite foreign key
     * already refuses another tenant's project, but it surfaces as a 500; an organization-wide
     * caller skips the relation gate, so without this pre-resolution a missing or cross-tenant
     * `projectId` would fall through to that foreign key.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /**
     * Read-only, used the same way for the optional `meetingId`: a named meeting is resolved inside
     * the tenant (and the acting project) before the write, so an unknown or cross-tenant meeting is
     * a 404, not a foreign-key 500.
     */
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
  ) {}

  /**
   * List a project's decisions the principal may read, most recently decided first.
   *
   * The tenant filter is the repository's; the deterministic `decided_at DESC` order is too. What
   * this adds is the relation filter: a member without organization-wide scope sees a project's
   * decisions only if they belong to that project. Filtered after the read rather than pushed into
   * the query, for the reason `MeetingsService.list` gives — `authorize()` is the single place the
   * relation rule lives, and a `WHERE ... IN (...)` copy would be free to disagree with it.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<readonly DecisionView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.decisions.list(runner, context, options),
    );

    return rows
      .filter(
        (row) =>
          authorize({
            principal,
            capability: 'work.read',
            resource: {
              organizationId: row.organizationId,
              projectId: row.projectId,
              audience: 'internal',
              lifecycle: 'active',
            },
          }).allowed,
      )
      .map(toView);
  }

  /**
   * Author a decision in a project the principal may write to.
   *
   * The Known-trap order (FAST-PROTOCOL, 19:55): every id the body names is resolved tenant-scoped
   * **before** the relation check and the write, so a missing or cross-tenant id is a 404 rather
   * than a foreign-key 500 the `HttpExceptionFilter` cannot map:
   *
   * 1. The named project is resolved inside this tenant (`findById` is tenant-scoped). Unknown or
   *    another organization's ⇒ 404.
   * 2. If a `meetingId` is given, it is resolved inside this tenant and must belong to the same
   *    project. Unknown, another organization's, or another project's ⇒ 404 — a decision links a
   *    meeting of its own project, and a non-member must not be able to probe which meetings exist.
   * 3. The relation check: a caller who names a project they are not a member of gets not found,
   *    never forbidden — 403 would confirm the project exists. An organization-wide role passes it.
   * 4. The write.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly projectId: string;
      readonly meetingId?: string | null;
      readonly title: string;
      readonly statement: string;
      readonly status: DecisionStatus;
      readonly decidedAt: Date;
    },
  ): Promise<DecisionView> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, input.projectId),
    );

    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    if (input.meetingId !== undefined && input.meetingId !== null) {
      const meeting = await this.database.read(context, (runner) =>
        this.meetings.findById(runner, context, input.meetingId as string),
      );
      // Unknown / cross-tenant, or a meeting on a different project of this tenant: not found. The
      // decision's meeting must be one of the decision's own project.
      if (!meeting || meeting.projectId !== input.projectId) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');
      }
    }

    const permitted = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: context.organizationId,
        projectId: input.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const toWrite: CreateDecisionInput = {
      projectId: input.projectId,
      meetingId: input.meetingId ?? null,
      title: input.title,
      statement: input.statement,
      status: input.status,
      decidedBy: context.userId,
      decidedAt: input.decidedAt,
    };

    const row = await this.database.transaction(context, (tx) =>
      this.decisions.create(tx, context, toWrite),
    );

    return toView(row);
  }
}
