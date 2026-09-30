import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberAdminNotes, memberships } from '../../common/database/schema.js';
import type { MemberAdminNoteRow, MembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of admin private member notes (Administration module 18, x280). Every query carries an
 * `organization_id = context.organizationId` predicate, so a subject membership and its notes are
 * resolved, listed, appended and deleted only within the acting tenant — another studio's members and
 * their notes can never be read or written (`25-AUTH-AND-TENANT-ISOLATION` §6). The runner is a
 * parameter, not a field: the repository holds no connection and no state.
 */

/** No `organizationId` — it is taken from the context, so there is no field for a body to populate. */
export interface AppendMemberAdminNoteInput {
  readonly subjectMembershipId: string;
  readonly body: string;
  /** The membership the note is written under — the service passes `context.membershipId`. */
  readonly authorMembershipId: string;
}

export class MemberNotesRepository {
  /**
   * One membership by id for the acting tenant, if present — the resolve-before-authorize step. A
   * membership in another tenant, or no membership, resolves to `undefined` (the service turns that
   * into a 404 with no write). Scoped on `(organization_id, id)`, the columns `uq_memberships_org_id`
   * covers.
   */
  async findMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MembershipRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * One note by id for the acting tenant and subject membership, if present — the resolve-before-write
   * step for delete. A note under another member, another tenant, or no note resolves to `undefined`
   * (the service turns that into a 404 with no delete). Scoped on `(organization_id,
   * subject_membership_id, id)`, the columns `ix_member_admin_notes_subject` leads with.
   */
  async findNote(
    runner: TenantQueryRunner,
    context: TenantContext,
    subjectMembershipId: string,
    noteId: string,
  ): Promise<MemberAdminNoteRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberAdminNotes)
      .where(
        and(
          eq(memberAdminNotes.organizationId, context.organizationId),
          eq(memberAdminNotes.subjectMembershipId, subjectMembershipId),
          eq(memberAdminNotes.id, noteId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * List one member's notes within the acting tenant, newest first. Both `organization_id` and
   * `subject_membership_id` predicates are present; the sort is `id` descending, and UUIDv7 ids sort
   * in creation order, so the newest note is first without a second sort column.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    subjectMembershipId: string,
  ): Promise<readonly MemberAdminNoteRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(memberAdminNotes)
      .where(
        and(
          eq(memberAdminNotes.organizationId, context.organizationId),
          eq(memberAdminNotes.subjectMembershipId, subjectMembershipId),
        ),
      )
      .orderBy(desc(memberAdminNotes.id));
  }

  /**
   * Append one note for the acting tenant. The id is generated here (UUIDv7). `organization_id` comes
   * from the context, never from `input`. The subject membership is *not* re-checked here — the
   * composite foreign key `fk_member_admin_notes_subject` refuses a membership from another tenant —
   * but the service has already resolved it tenant-scoped before this insert (the Known trap), so a
   * cross-tenant id is a 404, never a foreign-key error reached here.
   */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AppendMemberAdminNoteInput,
  ): Promise<MemberAdminNoteRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(memberAdminNotes).values({
      id,
      organizationId: context.organizationId,
      subjectMembershipId: input.subjectMembershipId,
      body: input.body,
      authorMembershipId: input.authorMembershipId,
      createdAt: sql`current_timestamp(3)`,
    });

    const rows = await db
      .select()
      .from(memberAdminNotes)
      .where(
        and(
          eq(memberAdminNotes.organizationId, context.organizationId),
          eq(memberAdminNotes.id, id),
        ),
      )
      .limit(1);
    // The row now carries the server-generated timestamp; reading it back keeps the two in step.
    return rows[0] as MemberAdminNoteRow;
  }

  /**
   * Delete one note for the acting tenant and subject membership. Scoped on `(organization_id,
   * subject_membership_id, id)`, so a note under another member or tenant is never touched (the
   * service has already resolved it tenant-scoped).
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    subjectMembershipId: string,
    noteId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(memberAdminNotes)
      .where(
        and(
          eq(memberAdminNotes.organizationId, context.organizationId),
          eq(memberAdminNotes.subjectMembershipId, subjectMembershipId),
          eq(memberAdminNotes.id, noteId),
        ),
      );
  }
}
