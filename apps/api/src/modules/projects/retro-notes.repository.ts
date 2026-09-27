import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectRetroNotes } from '../../common/database/schema.js';
import type { ProjectRetroNoteRow } from '../../common/database/schema.js';
import type { PROJECT_RETRO_NOTE_CATEGORIES } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project retrospective-notes repository — PROJ / module 8 (x311), following the
 * `status-updates` / `risk-register` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first
 * two parameters are the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the
 * tenant comes from the context and never the DTO ({@link CreateProjectRetroNoteInput} has no
 * `organizationId`), and the tenant predicate is on every statement. The log is append-oriented with
 * a delete: there is no `update`.
 */

export type ProjectRetroNoteCategory = (typeof PROJECT_RETRO_NOTE_CATEGORIES)[number];

/** Note the absent `organizationId`: it is taken from the context, so no body can populate it. */
export interface CreateProjectRetroNoteInput {
  readonly projectId: string;
  /** NULL when the note is about the project as a whole; the service has resolved it tenant-scoped. */
  readonly milestoneId: string | null;
  readonly category: ProjectRetroNoteCategory;
  readonly body: string;
  /** The person who captured the note — the service passes `context.userId`. */
  readonly createdBy: string;
}

export class ProjectRetroNotesRepository {
  /**
   * List one project's retro notes, within the acting tenant, newest first.
   *
   * Both `organization_id` and `project_id` predicates are present. The order is `created_at DESC,
   * id DESC`: the board reads newest-first, and `id` (UUIDv7, time-ordered) is the deterministic
   * tiebreaker. The service groups the flat list by category for the view.
   */
  async listByProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ProjectRetroNoteRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(projectRetroNotes)
      .where(
        and(
          eq(projectRetroNotes.organizationId, context.organizationId),
          eq(projectRetroNotes.projectId, projectId),
        ),
      )
      .orderBy(desc(projectRetroNotes.createdAt), desc(projectRetroNotes.id));
  }

  /**
   * Fetch one note by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    noteId: string,
  ): Promise<ProjectRetroNoteRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectRetroNotes)
      .where(
        and(
          eq(projectRetroNotes.organizationId, context.organizationId),
          eq(projectRetroNotes.id, noteId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Capture a retro note.
   *
   * The id is generated here (UUIDv7). `organization_id` comes from the context, never from `input`.
   * The project and any milestone are not checked to belong to the tenant here: the composite foreign
   * keys include `organization_id`, so the database refuses one from another tenant. (The service
   * resolves both first, to map an unknown id to 404/400 rather than a foreign-key 500.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectRetroNoteInput,
  ): Promise<ProjectRetroNoteRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(projectRetroNotes).values({
      id,
      organizationId: context.organizationId,
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      category: input.category,
      body: input.body,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    const row = await this.findById(runner, context, id);
    if (!row) {
      // Unreachable: the row was just inserted under this tenant. Guards the non-null return.
      throw new Error(`project retro note ${id} was not found after insert`);
    }
    return row;
  }

  /**
   * Remove a note by id, within the acting tenant. The predicate carries both `organization_id` and
   * `id`, so a cross-tenant id deletes nothing — the delete is idempotent and the service has already
   * resolved the note's project tenant-scoped for the relation gate.
   */
  async deleteById(
    runner: TenantQueryRunner,
    context: TenantContext,
    noteId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(projectRetroNotes)
      .where(
        and(
          eq(projectRetroNotes.organizationId, context.organizationId),
          eq(projectRetroNotes.id, noteId),
        ),
      );
  }
}
