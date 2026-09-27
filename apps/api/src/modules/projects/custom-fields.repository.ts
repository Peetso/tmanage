import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectCustomFields } from '../../common/database/schema.js';
import type {
  PROJECT_CUSTOM_FIELD_TYPES,
  ProjectCustomFieldRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project custom-fields repository — PROJ / module 8 (x310), following the `risk-register` /
 * `status-updates` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first
 * two parameters are the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the
 * tenant comes from the context and never a DTO, and the `organization_id` predicate is on every
 * statement. Definitions and values share one table with a `row_kind` discriminator; a definition
 * carries the empty sentinel `''` in `project_id` (see the migration), so the unique key
 * `(organization_id, project_id, field_key)` enforces both uniqueness rules and is the upsert key for
 * setting a value.
 */

export type ProjectCustomFieldType = (typeof PROJECT_CUSTOM_FIELD_TYPES)[number];

/** The sentinel `project_id` a definition row carries — never a real project id. */
export const DEFINITION_PROJECT_SENTINEL = '';

/** Note the absent `organizationId`: it is taken from the context, so no body can populate it. */
export interface CreateFieldDefinitionInput {
  readonly fieldKey: string;
  readonly name: string;
  readonly fieldType: ProjectCustomFieldType;
  /** For a `select` field, the allowed options; undefined for `text`/`number`. */
  readonly options?: readonly string[];
}

export interface SetFieldValueInput {
  readonly projectId: string;
  readonly fieldKey: string;
  readonly valueText: string;
}

export class ProjectCustomFieldsRepository {
  /** List the organization's field definitions, in key order. */
  async listDefinitions(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly ProjectCustomFieldRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(projectCustomFields)
      .where(
        and(
          eq(projectCustomFields.organizationId, context.organizationId),
          eq(projectCustomFields.rowKind, 'definition'),
        ),
      )
      .orderBy(asc(projectCustomFields.fieldKey));
  }

  /** Fetch one definition by key, within the acting tenant, or null. */
  async findDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    fieldKey: string,
  ): Promise<ProjectCustomFieldRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(projectCustomFields)
      .where(
        and(
          eq(projectCustomFields.organizationId, context.organizationId),
          eq(projectCustomFields.rowKind, 'definition'),
          eq(projectCustomFields.fieldKey, fieldKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** List one project's values, within the acting tenant, in key order. */
  async listValues(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ProjectCustomFieldRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(projectCustomFields)
      .where(
        and(
          eq(projectCustomFields.organizationId, context.organizationId),
          eq(projectCustomFields.rowKind, 'value'),
          eq(projectCustomFields.projectId, projectId),
        ),
      )
      .orderBy(asc(projectCustomFields.fieldKey));
  }

  /**
   * Create a field definition. `organization_id` comes from the context; `project_id` is the sentinel
   * `''`. A duplicate `field_key` collides on `uq_project_custom_fields_scope` — the service maps that
   * to a 409.
   */
  async createDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateFieldDefinitionInput,
  ): Promise<ProjectCustomFieldRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(projectCustomFields).values({
      id,
      organizationId: context.organizationId,
      rowKind: 'definition',
      projectId: DEFINITION_PROJECT_SENTINEL,
      fieldKey: input.fieldKey,
      name: input.name,
      fieldType: input.fieldType,
      optionsJson: input.options ?? null,
      valueText: null,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });
    const row = await this.findDefinition(runner, context, input.fieldKey);
    if (!row) {
      // Unreachable: the row was just inserted under this tenant. Guards the non-null return.
      throw new Error(`project custom field definition ${input.fieldKey} not found after insert`);
    }
    return row;
  }

  /**
   * Delete a definition by key, within the acting tenant. The service resolves the definition first
   * (an unknown key is a 404), so this is an unconditional scoped delete. Any per-project values that
   * referenced the key are left as-is — they resolve as "unknown field" in the value map, and a later
   * cleanup slice can prune them; deleting them here would be a second write this slice does not own.
   */
  async deleteDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    fieldKey: string,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(projectCustomFields)
      .where(
        and(
          eq(projectCustomFields.organizationId, context.organizationId),
          eq(projectCustomFields.rowKind, 'definition'),
          eq(projectCustomFields.fieldKey, fieldKey),
        ),
      );
  }

  /**
   * Set a project's value for a field, idempotently. The insert collides with the existing value on
   * `uq_project_custom_fields_scope` and updates `value_text` in place, so re-setting a field moves
   * the value rather than creating a second row. `organization_id` comes from the context.
   */
  async setValue(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: SetFieldValueInput,
  ): Promise<ProjectCustomFieldRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db
      .insert(projectCustomFields)
      .values({
        id,
        organizationId: context.organizationId,
        rowKind: 'value',
        projectId: input.projectId,
        fieldKey: input.fieldKey,
        name: null,
        fieldType: null,
        optionsJson: null,
        valueText: input.valueText,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: { valueText: input.valueText, updatedAt: sql`current_timestamp(3)` },
      });

    const rows = await db
      .select()
      .from(projectCustomFields)
      .where(
        and(
          eq(projectCustomFields.organizationId, context.organizationId),
          eq(projectCustomFields.rowKind, 'value'),
          eq(projectCustomFields.projectId, input.projectId),
          eq(projectCustomFields.fieldKey, input.fieldKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) {
      // Unreachable: the upsert above wrote the row under this tenant. Guards the non-null return.
      throw new Error(`project custom field value ${input.fieldKey} not found after upsert`);
    }
    return row;
  }
}
