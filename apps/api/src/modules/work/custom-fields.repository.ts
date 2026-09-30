import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workItemCustomFields } from '../../common/database/schema.js';
import type { WorkItemCustomFieldRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work item custom fields — x306's storage half (Work module).
 *
 * One table serves two row kinds (see `0174_work_item_custom_fields.sql`): a **definition** row
 * (`row_kind = 'definition'`) carries `definition_key` + `name` + `field_type` (+ `options`) with
 * `work_item_id`/`value_key`/`value_text` NULL; a **value** row (`row_kind = 'value'`) carries
 * `work_item_id` + `value_key` + `value_text` with the definition columns NULL. Every read and write
 * is bound to `(organization_id, …)`, so a caller in the wrong tenant sees nothing rather than a
 * leak, and the repository holds no policy — the service decides who may read or write, and the
 * composite foreign key of migration 0174 makes a cross-tenant `work_item_id` a non-existent pair.
 */

/** The largest custom-field page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_CUSTOM_FIELDS_PAGE = 500;

export interface CreateFieldDefinitionInput {
  readonly definitionKey: string;
  readonly name: string;
  readonly fieldType: 'text' | 'number' | 'select';
  readonly options: readonly string[] | null;
}

export interface UpsertFieldValueInput {
  readonly workItemId: string;
  readonly valueKey: string;
  readonly valueText: string;
}

export class WorkCustomFieldsRepository {
  /** The tenant's field definitions, key-ascending, bounded to one page. */
  async listDefinitions(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number = MAX_CUSTOM_FIELDS_PAGE,
  ): Promise<readonly WorkItemCustomFieldRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemCustomFields)
      .where(
        and(
          eq(workItemCustomFields.organizationId, context.organizationId),
          eq(workItemCustomFields.rowKind, 'definition'),
        ),
      )
      .orderBy(asc(workItemCustomFields.definitionKey), asc(workItemCustomFields.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_CUSTOM_FIELDS_PAGE));
  }

  /** One definition by its key, scoped to the tenant; `null` if the key is free. */
  async findDefinitionByKey(
    runner: TenantQueryRunner,
    context: TenantContext,
    definitionKey: string,
  ): Promise<WorkItemCustomFieldRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemCustomFields)
      .where(
        and(
          eq(workItemCustomFields.organizationId, context.organizationId),
          eq(workItemCustomFields.rowKind, 'definition'),
          eq(workItemCustomFields.definitionKey, definitionKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Define a field. Definition rows carry the shape and NULL `work_item_id`/`value_key`/`value_text`. */
  async createDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateFieldDefinitionInput,
  ): Promise<WorkItemCustomFieldRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(workItemCustomFields)
      .values({
        id,
        organizationId: context.organizationId,
        rowKind: 'definition',
        definitionKey: input.definitionKey,
        name: input.name,
        fieldType: input.fieldType,
        options: input.options ?? null,
        workItemId: null,
        valueKey: null,
        valueText: null,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });

    const created = await this.findDefinitionByKey(runner, context, input.definitionKey);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('custom-field definition vanished immediately after insert');
    }
    return created;
  }

  /** Remove a field definition by key. `true` if a row was removed. Values are left in place. */
  async deleteDefinition(
    runner: TenantQueryRunner,
    context: TenantContext,
    definitionKey: string,
  ): Promise<boolean> {
    const existing = await this.findDefinitionByKey(runner, context, definitionKey);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(workItemCustomFields)
      .where(
        and(
          eq(workItemCustomFields.organizationId, context.organizationId),
          eq(workItemCustomFields.rowKind, 'definition'),
          eq(workItemCustomFields.definitionKey, definitionKey),
        ),
      );
    return true;
  }

  /** The value rows for one work item of this tenant. */
  async listValues(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    limit: number = MAX_CUSTOM_FIELDS_PAGE,
  ): Promise<readonly WorkItemCustomFieldRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workItemCustomFields)
      .where(
        and(
          eq(workItemCustomFields.organizationId, context.organizationId),
          eq(workItemCustomFields.rowKind, 'value'),
          eq(workItemCustomFields.workItemId, workItemId),
        ),
      )
      .orderBy(asc(workItemCustomFields.valueKey), asc(workItemCustomFields.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_CUSTOM_FIELDS_PAGE));
  }

  /** One value for a (work item, field key) pair, scoped to the tenant; `null` if unset. */
  async findValue(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    valueKey: string,
  ): Promise<WorkItemCustomFieldRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workItemCustomFields)
      .where(
        and(
          eq(workItemCustomFields.organizationId, context.organizationId),
          eq(workItemCustomFields.rowKind, 'value'),
          eq(workItemCustomFields.workItemId, workItemId),
          eq(workItemCustomFields.valueKey, valueKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Set or revise the single value for a (work item, field key) pair. Idempotent by the
   * `(organization_id, work_item_id, value_key)` unique key — a re-set revises `value_text` in place.
   */
  async upsertValue(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertFieldValueInput,
  ): Promise<WorkItemCustomFieldRow> {
    await tenantDrizzle(runner)
      .insert(workItemCustomFields)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        rowKind: 'value',
        definitionKey: null,
        name: null,
        fieldType: null,
        options: null,
        workItemId: input.workItemId,
        valueKey: input.valueKey,
        valueText: input.valueText,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          valueText: input.valueText,
          updatedAt: sql`current_timestamp(3)`,
        },
      });

    const saved = await this.findValue(runner, context, input.workItemId, input.valueKey);
    if (!saved) {
      // Unreachable: the upsert above committed this row in this transaction.
      throw new Error('custom-field value vanished immediately after upsert');
    }
    return saved;
  }
}
