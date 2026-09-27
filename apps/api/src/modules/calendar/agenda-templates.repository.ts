import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetingAgendaTemplates } from '../../common/database/schema.js';
import type {
  MeetingAgendaTemplateItem,
  MeetingAgendaTemplateRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The agenda-templates repository — CAL agenda templates (x314), following the `work_forms` (0052)
 * and `meeting_series` (0043) org-scoped pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings repository honours it: every method's first two parameters are the `TenantQueryRunner`
 * and the `TenantContext` (there is no unscoped overload), the tenant comes from the context and
 * never from the DTO (the inputs carry no `organizationId`), and every statement carries the tenant
 * predicate and runs through the guard (`drizzle.ts`). A template is org-scoped — it names no
 * project — so, unlike a meeting, there is no project predicate; the scope is the tenant alone.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/**
 * Injection token for {@link AgendaTemplatesRepository}. Slice-local (declared beside the class it
 * provides) to keep this slice file-disjoint from the shared `common/http/tokens.ts` append point,
 * the convention {@link MeetingRsvpRepository} and {@link MeetingAgendaRepository} follow.
 */
export const AGENDA_TEMPLATES_REPOSITORY = Symbol('AGENDA_TEMPLATES_REPOSITORY');

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreateAgendaTemplateInput {
  readonly name: string;
  readonly items: readonly MeetingAgendaTemplateItem[];
  /** The person creating the template — the service passes `context.userId`. */
  readonly createdBy: string;
}

/** The mutable fields of a template: an idempotent PUT replaces both. Identity is pinned by 0182. */
export interface UpdateAgendaTemplateInput {
  readonly name: string;
  readonly items: readonly MeetingAgendaTemplateItem[];
}

export interface ListAgendaTemplatesOptions {
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class AgendaTemplatesRepository {
  /**
   * List a tenant's agenda templates, oldest-first by id.
   *
   * The `organization_id` predicate is present; keyset rather than offset pagination on `id`, the
   * way the meeting-series repository walks pages — `(organization_id, id)` is a key the schema
   * carries and UUIDv7 ids sort in creation order, so the walk is chronological without a second
   * sort column.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListAgendaTemplatesOptions,
  ): Promise<readonly MeetingAgendaTemplateRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [eq(meetingAgendaTemplates.organizationId, context.organizationId)];
    if (options.after) predicates.push(gt(meetingAgendaTemplates.id, options.after));

    return db
      .select()
      .from(meetingAgendaTemplates)
      .where(and(...predicates))
      .orderBy(asc(meetingAgendaTemplates.id))
      .limit(limit);
  }

  /**
   * Fetch one template by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row. A
   * cross-tenant id resolves to `null`.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<MeetingAgendaTemplateRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingAgendaTemplates)
      .where(
        and(
          eq(meetingAgendaTemplates.organizationId, context.organizationId),
          eq(meetingAgendaTemplates.id, templateId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create an agenda template.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The row is read back so it carries the server-generated timestamps.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateAgendaTemplateInput,
  ): Promise<MeetingAgendaTemplateRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(meetingAgendaTemplates).values({
      id,
      organizationId: context.organizationId,
      name: input.name,
      itemsJson: input.items,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    return this.requireById(runner, context, id);
  }

  /**
   * Replace a template's mutable fields (name + items), tenant-scoped.
   *
   * Only `name` and `items_json` are written; the identity columns are pinned by the 0182 trigger,
   * so a cross-tenant `organization_id` can never be smuggled in through this path. The write is
   * scoped by `(organization_id, id)`; the caller resolves existence first, so a missing row is a
   * no-op update whose read-back the service turns into the 404.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    input: UpdateAgendaTemplateInput,
  ): Promise<MeetingAgendaTemplateRow> {
    const db = tenantDrizzle(runner);

    await db
      .update(meetingAgendaTemplates)
      .set({ name: input.name, itemsJson: input.items })
      .where(
        and(
          eq(meetingAgendaTemplates.organizationId, context.organizationId),
          eq(meetingAgendaTemplates.id, templateId),
        ),
      );

    return this.requireById(runner, context, templateId);
  }

  /**
   * Delete a template by id, tenant-scoped. Returns whether a row was removed, so the service can
   * turn a cross-tenant or unknown id into a 404 rather than a silent 204.
   */
  async delete(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const result = await db
      .delete(meetingAgendaTemplates)
      .where(
        and(
          eq(meetingAgendaTemplates.organizationId, context.organizationId),
          eq(meetingAgendaTemplates.id, templateId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<MeetingAgendaTemplateRow> {
    const found = await this.findById(runner, context, templateId);
    if (!found) {
      // Unreachable after an insert in the same transaction; on update it means the row vanished
      // between the scoped existence check and the write, which the service treats as not-found.
      throw new Error(`meeting_agenda_template ${templateId} was not found after write`);
    }
    return found;
  }
}
