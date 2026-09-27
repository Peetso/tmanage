import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingActionItemsRepository } from './meeting-action-items.repository.js';
import type {
  ActionItemStatus,
  CreateActionItemInput,
  ListActionItemsOptions,
  UpdateActionItemInput,
} from './meeting-action-items.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { MeetingActionItemRow, MeetingRow } from '../../common/database/schema.js';

/**
 * The application service for CAL / MTG-03 meeting action items (x266) — the object-level decision
 * the route guard cannot make, and the transaction boundary the controller may not open. It follows
 * the `MeetingAttendeesService` shape (x126) and reuses that slice's authorization reasoning
 * verbatim.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse `meeting.read` / `meeting.write` question: does this
 * role's ceiling include the capability at all. This service adds the **relation** check with the
 * meeting's project in hand — an internal member without organization-wide scope reads and writes
 * action items only for meetings on projects they belong to. That relation check is expressed with
 * the sibling `work.read` / `work.create` capabilities, exactly as `MeetingAttendeesService` does:
 * `meeting.read`/`meeting.write` were declared as ceiling-mirrors of `work.read`/`work.create`, so
 * the two are equal by construction and `work.*` is what `authorize()` already relation-gates.
 *
 * ## Resolve-before-authorize, then resolve the owner
 *
 * The meeting is resolved tenant-scoped and relation-checked **before** any write (the Known-trap
 * order): an unknown or cross-tenant `meetingId` is a 404 with no write, and a caller off the
 * meeting's project relation gets the same 404, never a 403 — so a non-member can tell neither which
 * meetings exist nor which they are barred from. Only then is a supplied owner resolved tenant-scoped
 * — after the caller has proven they may write the meeting, so the owner read cannot double as a
 * membership probe — and an unknown owner is a not-found rather than a composite foreign-key 500.
 */

/**
 * What a caller is allowed to see of a meeting action item. `organizationId` is deliberately absent
 * (`25-AUTH-AND-TENANT-ISOLATION` §7); `meetingId` is the parent already in the caller's hand from
 * the route. The owner is named by `ownerMembershipId` (the tenant-composite identity the roster and
 * project membership use), or null for an unassigned action.
 */
export interface MeetingActionItemView {
  readonly id: string;
  readonly meetingId: string;
  readonly title: string;
  readonly ownerMembershipId: string | null;
  /** A `YYYY-MM-DD` date-only string on the wire, or null for no due date. */
  readonly dueOn: string | null;
  /** `open` or `done`. */
  readonly status: ActionItemStatus;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toView(row: MeetingActionItemRow): MeetingActionItemView {
  return {
    id: row.id,
    meetingId: row.meetingId,
    title: row.title,
    ownerMembershipId: row.ownerMembershipId,
    dueOn: row.dueOn,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateActionItemCommand {
  readonly meetingId: string;
  readonly title: string;
  readonly ownerMembershipId: string | null;
  readonly dueOn: string | null;
}

export interface UpdateActionItemCommand {
  readonly meetingId: string;
  readonly actionItemId: string;
  readonly changes: UpdateActionItemInput;
}

export interface DeleteActionItemCommand {
  readonly meetingId: string;
  readonly actionItemId: string;
}

export class MeetingActionItemsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly actionItems: MeetingActionItemsRepository = new MeetingActionItemsRepository(),
    /**
     * Read-only, used to resolve the meeting named in the path tenant-scoped before any authorize
     * or write — the Known-trap order. Stateless, so a fresh handle is cheap.
     */
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
    /**
     * Read-only, used to resolve a supplied owner's membership inside this tenant before the write —
     * so an unknown or cross-tenant `ownerMembershipId` is a clean not-found, not a composite
     * foreign-key 500.
     */
    private readonly memberships: MembershipsRepository = new MembershipsRepository(),
  ) {}

  /**
   * Resolve a meeting the principal may act on with `capability`, or throw the same **not found** a
   * missing meeting throws.
   *
   * The route names the meeting by id, so it is resolved **tenant-scoped first**: an unknown or
   * cross-tenant `meetingId` is `null` → 404, never a 500 from a foreign key. Only then is the
   * relation checked with the meeting's project in hand — a caller off that relation gets the same
   * 404, never a 403.
   */
  private async resolveMeetingFor(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    capability: 'work.read' | 'work.create',
  ): Promise<MeetingRow> {
    const meeting = await this.database.read(context, (runner) =>
      this.meetings.findById(runner, context, meetingId),
    );

    if (!meeting) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');
    }

    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: meeting.organizationId,
        projectId: meeting.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');
    }

    return meeting;
  }

  /**
   * Resolve a supplied owner's membership inside the acting tenant, after the caller has proven they
   * may write the meeting. An unknown or cross-tenant owner is a 404 (`owner must be an org member`);
   * a null owner (unassigned) resolves to null without a read.
   */
  private async resolveOwner(
    context: TenantContext,
    ownerMembershipId: string | null,
  ): Promise<string | null> {
    if (ownerMembershipId === null) return null;

    const membership = await this.database.read(context, (runner) =>
      this.memberships.findById(runner, context, ownerMembershipId),
    );
    if (!membership) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'owner_not_visible');
    }
    return membership.id;
  }

  /**
   * List a meeting's action items, deterministically ordered, for a caller who may read the meeting.
   *
   * The meeting is resolved and relation-checked first; a caller who cannot read it gets 404, not an
   * empty list, so the list never doubles as a probe for a meeting's existence.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListActionItemsOptions,
  ): Promise<readonly MeetingActionItemView[]> {
    await this.resolveMeetingFor(context, principal, options.meetingId, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.actionItems.list(runner, context, options),
    );

    return rows.map(toView);
  }

  /**
   * Capture an action item on a meeting the principal may write to.
   *
   * The meeting is resolved tenant-scoped and relation-checked before the write (Known-trap order),
   * then any supplied owner is resolved tenant-scoped, so an unknown owner is a 404 rather than a
   * composite foreign-key 500. A new item starts `open`.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    command: CreateActionItemCommand,
  ): Promise<MeetingActionItemView> {
    await this.resolveMeetingFor(context, principal, command.meetingId, 'work.create');
    const ownerMembershipId = await this.resolveOwner(context, command.ownerMembershipId);

    const input: CreateActionItemInput = {
      meetingId: command.meetingId,
      title: command.title,
      ownerMembershipId,
      dueOn: command.dueOn,
    };

    const row = await this.database.transaction(context, (tx) =>
      this.actionItems.create(tx, context, input),
    );

    return toView(row);
  }

  /**
   * Edit an action item (title, owner, due date, status), for a caller who may write the meeting.
   *
   * The meeting is resolved tenant-scoped and relation-checked first. The item is then resolved
   * tenant-scoped and checked to belong to *this* meeting: an unknown, cross-tenant or cross-meeting
   * `actionItemId` is a 404 with no write. A supplied owner is resolved tenant-scoped besides.
   */
  async update(
    context: TenantContext,
    principal: Principal,
    command: UpdateActionItemCommand,
  ): Promise<MeetingActionItemView> {
    await this.resolveMeetingFor(context, principal, command.meetingId, 'work.create');

    const existing = await this.database.read(context, (runner) =>
      this.actionItems.findById(runner, context, command.actionItemId),
    );
    if (!existing || existing.meetingId !== command.meetingId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'action_item_not_visible');
    }

    // `ownerMembershipId` present in the changes means the caller intends to set it (possibly to
    // null, i.e. unassign); absent means leave it untouched. Only a present, non-null owner is
    // resolved. A supplied owner is re-pointed to its resolved id; the rest of the changes pass
    // through unchanged.
    const changes: UpdateActionItemInput =
      command.changes.ownerMembershipId === undefined
        ? command.changes
        : {
            ...command.changes,
            ownerMembershipId: await this.resolveOwner(context, command.changes.ownerMembershipId),
          };

    const row = await this.database.transaction(context, (tx) =>
      this.actionItems.update(tx, context, command.meetingId, command.actionItemId, changes),
    );

    return toView(row);
  }

  /**
   * Remove an action item, for a caller who may write the meeting.
   *
   * The meeting is resolved and relation-checked first, then the item is resolved tenant-scoped and
   * checked to belong to this meeting: an unknown, cross-tenant or cross-meeting id is a 404 with no
   * delete.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    command: DeleteActionItemCommand,
  ): Promise<void> {
    await this.resolveMeetingFor(context, principal, command.meetingId, 'work.create');

    const existing = await this.database.read(context, (runner) =>
      this.actionItems.findById(runner, context, command.actionItemId),
    );
    if (!existing || existing.meetingId !== command.meetingId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'action_item_not_visible');
    }

    await this.database.transaction(context, (tx) =>
      this.actionItems.remove(tx, context, command.meetingId, command.actionItemId),
    );
  }
}

export type { ActionItemStatus };
