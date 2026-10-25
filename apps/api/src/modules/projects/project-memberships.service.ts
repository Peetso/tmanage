import type { InternalRole } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectMembershipRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { ConversationsRepository } from '../conversations/conversations.repository.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import {
  ProjectMembershipNotFoundError,
  ProjectMembershipsRepository,
} from './project-memberships.repository.js';
import type { AddProjectMemberInput } from './project-memberships.repository.js';

/**
 * Project-membership commands — the first producer of audit events in this codebase.
 *
 * The repository below it has been complete since PROJ-001. What was missing was a place for
 * the *second* half of §3 step 8 — "record audit and outbox events in the same transaction as
 * the state change" — to happen, and the note at the top of
 * `project-memberships.repository.ts` says exactly what that absence cost:
 *
 *   "Removal is a real `DELETE` … That trade only holds if the revocation is recorded
 *    somewhere else, and today it is not: AUD-001 has no service and nothing writes an audit
 *    event."
 *
 * This is that somewhere else. Each command is one transaction containing the write and its
 * audit row, so there is no ordering in which one lands without the other.
 *
 * ## Why the row is read before it is deleted
 *
 * {@link remove} loads the membership first. Not to check the tenant — the repository's
 * `DELETE` is already scoped and a composite foreign key makes a cross-tenant row
 * unreachable — but because after the delete the facts are gone. `project_memberships` has no
 * soft-delete column, so the audit row is the only surviving record of *who* held *which
 * role* on *which project*. Deleting first and auditing afterwards would produce a revocation
 * event that names nothing.
 *
 * ## What is deliberately not here yet
 *
 * No `authorize()` call. `ProjectsService` makes the object-level decision because it loads a
 * project row with an audience and a lifecycle to decide against; a project membership has
 * neither, and the honest gate for these commands is the project's — which means it belongs
 * with the controller that will expose them (WEB/PROJ work not yet scheduled). Adding a
 * synthetic `ResourceContext` here to make the shape look complete is the mistake
 * `CapabilityGuard`'s own header records having made once already.
 */
export class ProjectMembershipsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: AuditService,
    private readonly memberships: ProjectMembershipsRepository = new ProjectMembershipsRepository(),
    /** CQ-12: optional so a suite can construct the service without the outbox. */
    private readonly outbox?: OutboxEventsRepository,
    private readonly conversations: ConversationsRepository = new ConversationsRepository(),
  ) {}

  /**
   * Put someone on a project, and record that it happened.
   *
   * CQ-12: in the same transaction the person joins the project's open channels (COL-01 — the
   * team's rooms are theirs too) and a `project.member_added.v1` event is written so the worker
   * tells them (COL-05). Adding yourself tells nobody.
   */
  async add(context: TenantContext, input: AddProjectMemberInput): Promise<ProjectMembershipRow> {
    return this.database.transaction(context, async (tx) => {
      const row = await this.memberships.add(tx, context, input);

      const channels = await this.conversations.listOpenIdsByProject(tx, context, row.projectId);
      for (const conversationId of channels) {
        await this.conversations.addMember(tx, context, conversationId, row.userId);
      }

      if (row.userId !== context.userId) {
        await this.outbox?.append(tx, context, {
          type: 'project.member_added.v1',
          aggregateId: row.projectId,
          payload: { projectId: row.projectId, userId: row.userId, addedByUserId: context.userId },
        });
      }

      await this.audit.record(tx, context, {
        action: 'project_membership.granted',
        result: 'allowed',
        objectId: row.id,
        metadata: {
          project_id: row.projectId,
          target_user_id: row.userId,
          granted_role: row.role,
        },
      });

      return row;
    });
  }

  /**
   * Change a project role.
   *
   * The audit row carries both roles. `changeRole` is a compare-and-swap on the old value, so
   * the event can state the transition rather than only its destination — which is the form
   * a reviewer asking "who made this person a lead" actually needs.
   *
   * A no-op change — the row already holds the requested role — still writes an event, with
   * `changed` false. The alternative is an audit trail in which an attempt and a
   * non-attempt are indistinguishable, and §12 audits the decision, not the diff.
   */
  async changeRole(
    context: TenantContext,
    projectMembershipId: string,
    expectedRole: InternalRole,
    role: InternalRole,
  ): Promise<ProjectMembershipRow> {
    return this.database.transaction(context, async (tx) => {
      const row = await this.memberships.changeRole(
        tx,
        context,
        projectMembershipId,
        expectedRole,
        role,
      );

      await this.audit.record(tx, context, {
        action: 'project_membership.role_changed',
        result: 'allowed',
        objectId: row.id,
        metadata: {
          project_id: row.projectId,
          target_user_id: row.userId,
          previous_role: expectedRole,
          new_role: row.role,
          changed: expectedRole !== row.role,
        },
      });

      return row;
    });
  }

  /**
   * Take someone off a project.
   *
   * Returns whether a row was removed, preserving the repository's idempotence: a second call
   * for an already-absent membership is success, not an error.
   *
   * **No audit row is written when nothing was removed.** That is the whole reason
   * `ProjectMembershipsRepository.remove()` returns a boolean — its own comment says it
   * exists "so a command that needs to write an audit event knows whether anything
   * happened". Writing a revocation for a membership that was already gone would make the
   * audit trail a record of requests rather than of facts, and would let a caller manufacture
   * evidence of a revocation that never occurred by retrying a delete.
   */
  async remove(context: TenantContext, projectMembershipId: string): Promise<boolean> {
    return this.database.transaction(context, async (tx) => {
      // Read first: after the delete these facts do not exist anywhere.
      const existing = await this.memberships.findById(tx, context, projectMembershipId);
      if (!existing) return false;

      const removed = await this.memberships.remove(tx, context, projectMembershipId);
      if (!removed) {
        // The row was there a statement ago and is not now. Another transaction removed it
        // between the two, so *that* transaction wrote the audit event. Writing a second one
        // here would double-count a single revocation.
        return false;
      }

      // F13: the channel rows `add` inserted are revoked with the project grant, in the same
      // transaction — membership may only narrow, so a row left behind would be a grant.
      await this.conversations.removeMemberFromProjectChannels(
        tx,
        context,
        existing.projectId,
        existing.userId,
      );

      await this.audit.record(tx, context, {
        action: 'project_membership.revoked',
        result: 'allowed',
        objectId: existing.id,
        metadata: {
          project_id: existing.projectId,
          target_user_id: existing.userId,
          revoked_role: existing.role,
        },
      });

      return true;
    });
  }

  /**
   * Take someone off a project, refusing if it is not there.
   *
   * The strict counterpart to {@link remove}, for a caller that means "this specific grant"
   * rather than "this person is not on this project". Both exist because the two intents want
   * opposite answers to the same absent row.
   */
  async removeExisting(context: TenantContext, projectMembershipId: string): Promise<void> {
    const removed = await this.remove(context, projectMembershipId);
    if (!removed) throw new ProjectMembershipNotFoundError(projectMembershipId);
  }
}
