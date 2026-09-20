import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import type { CreateMeetingInput, ListMeetingsOptions } from './meetings.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { MeetingRow } from '../../common/database/schema.js';

/**
 * The application service for CAL-01 / MTG-01 (x90) — the object-level decision the route guard
 * cannot make, and the transaction boundary the controller may not open. It follows the
 * `ProjectsService` shape.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse question `meeting.read` / `meeting.write`: does
 * this role's ceiling include the capability at all. That is all a guard can honestly answer,
 * because no object has been loaded. This service adds the **relation** check with the row's
 * project in hand — an internal member without organization-wide scope reads and writes only
 * the projects they belong to.
 *
 * That relation check is expressed with the sibling `work.read` / `work.create` capabilities
 * rather than with `meeting.*`. It is exact, not a shortcut: `meeting.read` was declared as a
 * ceiling-mirror of `work.read` and `meeting.write` of `work.create` (see
 * `packages/domain/src/policies/capabilities.ts`), so the two are equal by construction for
 * every role, and `work.*` is what `authorize()` already relation-gates. Relation-gating
 * `meeting.*` directly in `authorize.ts` would be an edit to the security core this slice does
 * not need; a later slice may make it so. Recorded as a decision in the x90 report.
 *
 * No audit event is written yet — like `ProjectsService`'s still-missing outbox event, the
 * audit action for a meeting is a follow-up (it needs a `meeting.*` entry in the `AuditAction`
 * catalog, a domain change out of this slice's scope).
 */

/** What a caller is allowed to see of a meeting. `organizationId` is deliberately absent. */
export interface MeetingView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant on the wire. */
  readonly startsAt: string;
  readonly agendaNote: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `meetings` in a future migration is invisible to every caller
 * until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: MeetingRow): MeetingView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    agendaNote: row.agendaNote,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class MeetingsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
    /**
     * Read-only, and used for one thing: proving the project a new meeting names exists **inside
     * this tenant** before the insert is attempted, exactly as `ConversationsService` does. The
     * composite foreign key already refuses another tenant's project, but it surfaces as a 500;
     * an organization-wide caller skips the relation gate, so without this pre-resolution a
     * missing or cross-tenant `projectId` would fall through to that foreign key. A stateless
     * repository is cheap to own a second handle on (the reasoning `ConversationsModule` records).
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * List a project's meetings the principal may read.
   *
   * The tenant filter is the repository's. What this adds is the relation filter: a member
   * without organization-wide scope sees a project's meetings only if they belong to that
   * project. Filtered after the read rather than pushed into the query, for the reason
   * `ProjectsService.list` gives — `authorize()` is the single place the relation rule lives,
   * and a `WHERE ... IN (...)` copy would be free to disagree with it.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListMeetingsOptions,
  ): Promise<readonly MeetingView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.meetings.list(runner, context, options),
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
   * Create a meeting in a project the principal may write to.
   *
   * Two checks precede the write, both surfacing the same **not found** so a caller can tell
   * neither which projects exist nor which ones they are barred from:
   *
   * 1. The named project is resolved inside this tenant first (`findById` is tenant-scoped). A
   *    projectId that is unknown or belongs to another organization returns `null` → 404, exactly
   *    as `ConversationsService.create` does. Without it an organization-wide caller — who passes
   *    the relation check below — would drive an unknown or cross-tenant id into the composite
   *    foreign key, which refuses the row but surfaces as a 500 rather than a not-found.
   * 2. The relation check: a caller who names a project they are not a member of gets not found,
   *    never forbidden — 403 would confirm the project exists, and which projects a studio runs is
   *    exactly what a non-member must not be able to enumerate (the reasoning `ProjectsService.get`
   *    gives). An organization-wide role passes it and reaches the tenant-resolved project above.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: Omit<CreateMeetingInput, 'createdByUserId'>,
  ): Promise<MeetingView> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, input.projectId),
    );

    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
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

    const row = await this.database.transaction(context, (tx) =>
      this.meetings.create(tx, context, { ...input, createdByUserId: context.userId }),
    );

    return toView(row);
  }
}
