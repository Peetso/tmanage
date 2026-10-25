import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MemberNotesRepository } from './member-notes.repository.js';
import type { MemberAdminNoteRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';

/**
 * The application service for admin private member notes (Administration module 18, x280).
 *
 * An org admin's private, internal annotation about a member: add a note, list a member's notes,
 * delete one. Every route is behind `org.manage` — the coarse `CapabilityGuard` question — and this
 * service adds the real org-wide `org.manage` decision plus the tenant-scoped resolve that is the
 * whole of the slice's safety.
 *
 * ## Resolve the subject (and, for delete, the note) tenant-scoped BEFORE authorize (the Known trap)
 *
 * The subject membership is read scoped to the tenant first, so a membership id in another tenant, or
 * one that does not exist, is a **404 with no write** decided *before* the `org.manage` authorize —
 * an org-wide admin who would pass the authorize regardless can never use this path to confirm a
 * foreign membership exists, and a cross-tenant note can never be written or read. Delete resolves the
 * note by `(tenant, subject, id)` too, so a note under another member or tenant is a 404 with no
 * delete. A note is **never** surfaced on any member-facing read path: the only reader is this
 * `org.manage`-gated surface.
 *
 * The author is the acting membership (`context.membershipId`), never a value from the body.
 *
 * ## Never about yourself, and never without a trace (wave 9 S8, audit F56)
 *
 * A note is never shown to the member it is about — including a member who holds `org.manage`. So
 * a subject equal to the caller's own membership is the module's 404 on every route, decided before
 * any note is read or deleted. Adding and deleting a note each append an audit row
 * (`member_admin_note.created` / `.deleted`, ids only, never the text) in the same transaction.
 */

/** What a caller is allowed to see of one member note. `organizationId` is deliberately absent. */
export interface MemberAdminNoteView {
  readonly id: string;
  readonly subjectMembershipId: string;
  readonly body: string;
  readonly authorMembershipId: string;
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `member_admin_notes` in a future migration is invisible to every
 * caller until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: MemberAdminNoteRow): MemberAdminNoteView {
  return {
    id: row.id,
    subjectMembershipId: row.subjectMembershipId,
    body: row.body,
    authorMembershipId: row.authorMembershipId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `member_admin_notes.body` is `TEXT`; this keeps a comfortable ceiling below the 65_535-byte max. */
const MAX_BODY_LENGTH = 60_000;

export class MemberNotesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly notes: MemberNotesRepository,
    private readonly audit: Pick<AuditService, 'record'>,
  ) {}

  /** F56: a note about the caller's own membership is invisible to them — the same 404. */
  private refuseSelfSubject(context: TenantContext, subjectMembershipId: string): void {
    if (subjectMembershipId === context.membershipId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'membership_not_visible');
    }
  }

  /**
   * Resolve the subject membership tenant-scoped, then authorize `org.manage` org-wide.
   *
   * The membership is read scoped to the tenant first (unknown/cross-tenant → 404, the Known trap),
   * *before* the real `org.manage` decision (denied → 403). A cross-tenant membership is therefore
   * indistinguishable from an unknown one, and never leaks its existence through a 403.
   */
  private async requireManageableSubject(
    context: TenantContext,
    principal: Principal,
    subjectMembershipId: string,
  ): Promise<void> {
    this.refuseSelfSubject(context, subjectMembershipId);
    const subject = await this.database.read(context, (runner) =>
      this.notes.findMembership(runner, context, subjectMembershipId),
    );
    if (!subject) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'membership_not_visible');
    }
    this.requireOrgManage(principal, context);
  }

  /** The real org-wide `org.manage` decision. A denial is a 403 with the machine-readable code. */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `member_admin_notes.manage:${verdict.code}`,
      );
    }
  }

  /**
   * List one member's private notes, newest first. `org.manage`. The subject membership is resolved
   * tenant-scoped first, so an unknown or cross-tenant membership id is a 404 before any note is read.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    subjectMembershipId: string,
  ): Promise<readonly MemberAdminNoteView[]> {
    await this.requireManageableSubject(context, principal, subjectMembershipId);
    const rows = await this.database.read(context, (runner) =>
      this.notes.list(runner, context, subjectMembershipId),
    );
    return rows.map(toView);
  }

  /**
   * Add a private note to a member. `org.manage`. The subject membership is resolved tenant-scoped and
   * authorized **before** the write, so an unknown or cross-tenant membership id is a 404 and
   * **nothing is written** (the Known trap). The author is the acting membership, never a body value.
   */
  async add(
    context: TenantContext,
    principal: Principal,
    subjectMembershipId: string,
    body: string,
  ): Promise<MemberAdminNoteView> {
    await this.requireManageableSubject(context, principal, subjectMembershipId);
    const row = await this.database.transaction(context, async (tx) => {
      const appended = await this.notes.append(tx, context, {
        subjectMembershipId,
        body,
        authorMembershipId: context.membershipId,
      });
      // F56: the note's existence is recorded with it (ids only — never the text).
      await this.audit.record(tx, context, {
        action: 'member_admin_note.created',
        result: 'allowed',
        objectId: appended.id,
        actorUserId: principal.userId,
        metadata: { target_membership_id: subjectMembershipId },
      });
      return appended;
    });
    return toView(row);
  }

  /**
   * Delete a private note from a member. `org.manage`. The subject membership is resolved tenant-scoped
   * first (404), then the note by `(tenant, subject, id)` (404), then the real `org.manage` authorize
   * (403), and only then the delete — so a cross-tenant or foreign id is a 404 with no delete.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    subjectMembershipId: string,
    noteId: string,
  ): Promise<void> {
    // F56: before any read or delete, a note about the caller themself is not theirs to see.
    this.refuseSelfSubject(context, subjectMembershipId);
    await this.database.transaction(context, async (tx) => {
      const subject = await this.notes.findMembership(tx, context, subjectMembershipId);
      if (!subject) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'membership_not_visible',
        );
      }
      const note = await this.notes.findNote(tx, context, subjectMembershipId, noteId);
      if (!note) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'note_not_visible');
      }
      this.requireOrgManage(principal, context);
      await this.notes.remove(tx, context, subjectMembershipId, noteId);
      await this.audit.record(tx, context, {
        action: 'member_admin_note.deleted',
        result: 'allowed',
        objectId: note.id,
        actorUserId: principal.userId,
        metadata: { target_membership_id: subjectMembershipId },
      });
    });
  }

  /** The maximum note body length the controller validates against before calling {@link add}. */
  static get maxBodyLength(): number {
    return MAX_BODY_LENGTH;
  }
}
