import { authorize } from '@tmanage/domain';
import type { Audience, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import type { ProjectRow, WorkItemRow } from '../../common/database/schema.js';

/**
 * The client portal's read surface — CLIENT-002.
 *
 * `CLIENT-001` made a client organization reachable and `TEN-003` made a client member
 * arrivable, and between them a client could sign in and see **nothing**: every endpoint in the
 * system serves the internal record, and `12-PERMISSION-MATRIX` §2 gives every client role
 * "View internal project: **Never**". The assertion parked in `http-pipeline.db.test.ts` since
 * the HTTP surface landed has been waiting for exactly this file.
 *
 * ## Not a filtered internal list
 *
 * `25-AUTH-AND-TENANT-ISOLATION` §7: "Never implement client access as
 * `serializeInternalObject(); delete fields`." Every view here is built field by field from
 * §4's allowlist — "public/client title, summary, milestone state, committed/forecast date,
 * published risk, deliverable version, decision, and approved contacts" — and a column added
 * to `projects` or `work_items` tomorrow is invisible to a client until somebody decides it
 * should not be. That is the safe direction, and it is the whole reason these are separate
 * projections rather than the internal ones with a filter in front.
 *
 * Two omissions are worth naming because they are the ones a filter would have got wrong:
 *
 * - **`ownerUserId` is absent.** §4 excludes staff. Who inside the agency is carrying a piece
 *   of work is an internal fact, and "approved contacts" — a curated list — is what a client
 *   is meant to see instead. That is `CL-10`, unbuilt.
 * - **The internal `state` is absent.** §4 gives "milestone state", not the work lifecycle. A
 *   client reading `internal_review` learns that their deliverable is being argued about
 *   inside the agency, which is precisely the internal signal `26-THREAT-MODELS` treats as a
 *   disclosure. The projection says whether the item is **finished, in progress or waiting on
 *   the client**, which is what the portal is for.
 *
 * ## Three independent gates, and none of them is this file being careful
 *
 * 1. `client_projection.read` — the capability `12-PERMISSION-MATRIX` §1 names and this
 *    codebase did not have until now. `CapabilityGuard` refuses a role without it.
 * 2. `authorize()` per row, which for a client principal refuses any project outside
 *    `principal.projectIds` — and that list comes from `project_clients` and nothing else.
 * 3. The audience filter, which is in the **query**: a client's read of `work_items` never
 *    selects an `internal` row, so there is no result set to be careless with.
 */

export interface PortalProjectView {
  readonly id: string;
  readonly name: string;
  /** §4: "milestone state". Until milestones exist, the project's own status. */
  readonly status: string;
  /** §4 names both dates explicitly, and they mean different things. */
  readonly committedAt: string | null;
  readonly forecastAt: string | null;
}

export interface PortalWorkItemView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /**
   * What the client needs to know, not the internal lifecycle.
   *
   * `waiting_on_you` is the one that earns its place: `client_action_required` is an audience,
   * and a portal that showed it as an ordinary item would bury the only rows the client is
   * expected to act on.
   */
  readonly progress: 'waiting_on_you' | 'in_progress' | 'done';
  readonly dueAt: string | null;
  readonly updatedAt: string;
}

/** The audiences a client may ever see. `internal` is not among them and never will be. */
const CLIENT_AUDIENCES: readonly Audience[] = ['client_visible', 'client_action_required'];

function toProjectView(row: ProjectRow): PortalProjectView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    committedAt: row.committedAt ? row.committedAt.toISOString() : null,
    forecastAt: row.forecastAt ? row.forecastAt.toISOString() : null,
  };
}

/**
 * The internal lifecycle collapsed to what a client is told.
 *
 * Deliberately lossy. `backlog`, `ready`, `in_progress`, `blocked` and `internal_review` all
 * read as "in progress", because the differences between them are internal: a client learning
 * that their deliverable is blocked, and on what, is a conversation somebody at the agency
 * should be having rather than a status a portal leaks.
 */
function progressOf(row: WorkItemRow): PortalWorkItemView['progress'] {
  if (row.audience === 'client_action_required') return 'waiting_on_you';
  if (row.state === 'done' || row.state === 'archived') return 'done';
  return 'in_progress';
}

function toWorkItemView(row: WorkItemRow): PortalWorkItemView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    progress: progressOf(row),
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PortalService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
  ) {}

  /**
   * The projects this principal may see through the portal.
   *
   * For a client, that is exactly the projects shared with their client organization —
   * `PrincipalRepository.projectScope` read `project_clients` to build the list and
   * `authorize()` rule 10 refuses anything outside it. For an internal principal it is the
   * projects they are related to, which is how anybody at the agency checks what a client can
   * see without asking the client.
   */
  async projectsFor(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly PortalProjectView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.projects.list(runner, context, {}),
    );

    return rows.filter((row) => this.mayRead(principal, row.id)).map(toProjectView);
  }

  /**
   * The client-facing work in one project, or across all of them.
   *
   * The audience filter is a **query predicate**, not a `.filter()` afterwards. An internal row
   * is never selected, so there is no moment at which this process holds one and has to
   * remember not to return it.
   */
  async workItemsFor(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId?: string } = {},
  ): Promise<readonly PortalWorkItemView[]> {
    if (options.projectId && !this.mayRead(principal, options.projectId)) {
      // 404, not 403. A client probing project ids must not learn which of them are real.
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const rows = await this.database.read(context, (runner) =>
      this.workItems.list(runner, context, {
        audiences: CLIENT_AUDIENCES,
        ...(options.projectId ? { projectId: options.projectId } : {}),
      }),
    );

    return rows.filter((row) => this.mayRead(principal, row.projectId)).map(toWorkItemView);
  }

  /**
   * May this principal read the client projection of this project?
   *
   * One call to `authorize()` per row, at audience `client_visible`, which is the audience the
   * projection actually has. For a client principal that runs rules 7 to 10: same client
   * organization, client-readable audience, published, and the project in `projectIds`.
   */
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
