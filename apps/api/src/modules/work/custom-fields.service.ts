import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemCustomFieldRow, WorkItemRow } from '../../common/database/schema.js';
import { WORK_ITEM_CUSTOM_FIELD_TYPES } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkCustomFieldsRepository } from './custom-fields.repository.js';

/**
 * x306's application service — org-defined custom fields on work items (Work module).
 *
 * Two objects, one table (see `0174_work_item_custom_fields.sql`): a **definition** the studio owns
 * (a text/number/select attribute), and a **value** a member sets for that field on a work item. The
 * rules that matter live here, the way `WorkLabelsService` places them:
 *
 * ## Definitions are org metadata behind `org.manage`
 *
 * Defining, listing and removing field definitions is an organization-settings action, so those
 * routes are behind `org.manage`. The route guard asks the coarse question (UX/defence); this service
 * authorizes `org.manage` again before it writes, so a caller without it is a 403 with no insert —
 * the refusal the unit test proves. A key is unique per tenant (the migration's unique key), and an
 * empty key or name is a 400 with no insert. A `select` field must carry a non-empty `options` list.
 *
 * ## Values inherit the work item's audience
 *
 * Setting and reading a value is scoped to the parent work item: the item is resolved tenant-scoped
 * BEFORE `authorize()` is asked, so a cross-tenant `work_item_id` is the same 404 an absent id gives,
 * before any write. Reading is `work.read`, setting is `work.update`. An unknown field key on a set
 * is a 404; a value that violates the field's type (a non-number for `number`, a value outside the
 * `select` options) is a 400 with no upsert. The set is an idempotent `PUT` — a re-set revises the
 * one value in place, never a duplicate.
 */

/** The client-facing projection of one field definition. Paired in `e2e/contracts`. */
export interface WorkCustomFieldDefinitionView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly fieldType: string;
  readonly options: readonly string[] | null;
  readonly createdAt: string;
}

/** The client-facing projection of one field resolved against a work item's value. Paired in `e2e/contracts`. */
export interface WorkCustomFieldValueView {
  readonly key: string;
  readonly name: string;
  readonly fieldType: string;
  readonly options: readonly string[] | null;
  /** The value set on this item, or `null` when the field is defined but unset for the item. */
  readonly value: string | null;
  readonly updatedAt: string | null;
}

export interface DefineFieldInput {
  readonly key: string;
  readonly name: string;
  readonly fieldType: string;
  readonly options: readonly string[] | null;
}

/** The longest a stored text value may be — a work-item attribute, not a document. */
export const MAX_CUSTOM_FIELD_VALUE_LENGTH = 2_000;
/** The most options a `select` field may declare. */
export const MAX_CUSTOM_FIELD_OPTIONS = 100;

export class WorkCustomFieldsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly fields: WorkCustomFieldsRepository = new WorkCustomFieldsRepository(),
  ) {}

  /** The tenant's field definitions, key-ascending. Behind `org.manage`. */
  async listDefinitions(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly WorkCustomFieldDefinitionView[]> {
    return this.database.read(context, async (runner) => {
      this.requireOrgManage(principal, context, 'list');
      const rows = await this.fields.listDefinitions(runner, context);
      return rows.map(toDefinitionView);
    });
  }

  /** Define a field. Behind `org.manage`. Duplicate key → 409, empty/bad shape → 400. */
  async define(
    context: TenantContext,
    principal: Principal,
    input: DefineFieldInput,
  ): Promise<WorkCustomFieldDefinitionView> {
    const key = requiredKey(input.key);
    const name = requiredName(input.name);
    const fieldType = requiredFieldType(input.fieldType);
    const options = requiredOptions(fieldType, input.options);
    return this.database.transaction(context, async (tx) => {
      // Authorize before the write: a caller without org.manage is a 403 with no insert.
      this.requireOrgManage(principal, context, 'define');
      const clash = await this.fields.findDefinitionByKey(tx, context, key);
      if (clash) {
        throw new ApiError(409, 'conflict', 'A custom field with this key already exists');
      }
      const row = await this.fields.createDefinition(tx, context, {
        definitionKey: key,
        name,
        fieldType,
        options,
      });
      return toDefinitionView(row);
    });
  }

  /** Remove a field definition. Behind `org.manage`. Idempotent — an absent key is a no-op 204. */
  async remove(context: TenantContext, principal: Principal, key: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      this.requireOrgManage(principal, context, 'remove');
      await this.fields.deleteDefinition(tx, context, key);
    });
  }

  /** The field+value map for a work item. Behind `work.read` on the parent item. */
  async listForItem(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly WorkCustomFieldValueView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const [definitions, values] = await Promise.all([
        this.fields.listDefinitions(runner, context),
        this.fields.listValues(runner, context, workItemId),
      ]);
      const valueByKey = new Map(values.map((row) => [row.valueKey ?? '', row]));
      return definitions.map((definition) =>
        toValueView(definition, valueByKey.get(definition.definitionKey ?? '')),
      );
    });
  }

  /** Set or revise a value for a field on a work item. Behind `work.update`. Unknown key → 404. */
  async setValue(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    key: string,
    rawValue: unknown,
  ): Promise<WorkCustomFieldValueView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // Resolve the field by (tenant, key) BEFORE the write; an unknown or cross-tenant key is a 404.
      const definition = await this.fields.findDefinitionByKey(tx, context, key);
      if (!definition) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      const valueText = coerceValue(definition, rawValue);
      const saved = await this.fields.upsertValue(tx, context, {
        workItemId,
        valueKey: key,
        valueText,
      });
      return toValueView(definition, saved);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404 for
   * "no relation" is produced here, before any write, and is the same 404 the work-item read produces
   * for a row that does not exist.
   */
  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private requireWrite(principal: Principal, parent: WorkItemRow): void {
    const verdict = authorize({
      principal,
      capability: 'work.update',
      resource: resourceOf(parent),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }

  /** Authorize an org-scoped `org.manage` (projectId null), or throw 403 with no write. */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        // Null: an org-level resource (organization metadata), no project relation to lean on.
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
        `${action}:${verdict.code}`,
      );
    }
  }
}

function resourceOf(row: WorkItemRow) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

function toDefinitionView(row: WorkItemCustomFieldRow): WorkCustomFieldDefinitionView {
  return {
    id: row.id,
    key: row.definitionKey ?? '',
    name: row.name ?? '',
    fieldType: row.fieldType ?? 'text',
    options: row.options ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A definition row plus its optional value row for one item. */
function toValueView(
  definition: WorkItemCustomFieldRow,
  value: WorkItemCustomFieldRow | undefined,
): WorkCustomFieldValueView {
  return {
    key: definition.definitionKey ?? '',
    name: definition.name ?? '',
    fieldType: definition.fieldType ?? 'text',
    options: definition.options ?? null,
    value: value?.valueText ?? null,
    updatedAt: value ? value.updatedAt.toISOString() : null,
  };
}

function requiredKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'key', message: 'must be a non-empty string' },
    ]);
  }
  if (key.length > 80) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'key', message: 'must be 80 characters or fewer' },
    ]);
  }
  return key;
}

function requiredName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be a non-empty string' },
    ]);
  }
  if (name.length > 160) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be 160 characters or fewer' },
    ]);
  }
  return name;
}

function requiredFieldType(raw: unknown): 'text' | 'number' | 'select' {
  if (
    typeof raw !== 'string' ||
    !(WORK_ITEM_CUSTOM_FIELD_TYPES as readonly string[]).includes(raw)
  ) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'fieldType', message: `must be one of: ${WORK_ITEM_CUSTOM_FIELD_TYPES.join(', ')}` },
    ]);
  }
  return raw as 'text' | 'number' | 'select';
}

/**
 * A `select` field must carry a non-empty list of non-empty, unique option strings; any other type
 * carries none. A bad options list is a 400 with no insert.
 */
function requiredOptions(
  fieldType: 'text' | 'number' | 'select',
  raw: readonly string[] | null | undefined,
): readonly string[] | null {
  if (fieldType !== 'select') return null;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'options', message: 'a select field must declare at least one option' },
    ]);
  }
  if (raw.length > MAX_CUSTOM_FIELD_OPTIONS) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'options', message: `must be ${MAX_CUSTOM_FIELD_OPTIONS} options or fewer` },
    ]);
  }
  const options = raw.map((option) => (typeof option === 'string' ? option.trim() : ''));
  if (options.some((option) => option === '')) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'options', message: 'every option must be a non-empty string' },
    ]);
  }
  if (new Set(options).size !== options.length) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'options', message: 'options must be unique' },
    ]);
  }
  return options;
}

/**
 * Coerce a set value to its stored text form, or throw a 400 with no upsert: a `select` value must be
 * one of the field's options, a `number` value must be a finite number (stored as its decimal
 * string), and a `text` value is any bounded string.
 */
function coerceValue(definition: WorkItemCustomFieldRow, raw: unknown): string {
  const fieldType = definition.fieldType ?? 'text';
  if (fieldType === 'select') {
    const allowed = definition.options ?? [];
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'value', message: `must be one of: ${allowed.join(', ')}` },
      ]);
    }
    return raw;
  }
  if (fieldType === 'number') {
    const asNumber = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (
      typeof raw === 'boolean' ||
      !Number.isFinite(asNumber) ||
      (typeof raw === 'string' && raw.trim() === '')
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'value', message: 'must be a number' },
      ]);
    }
    return String(asNumber);
  }
  // text
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'value', message: 'must be a string' },
    ]);
  }
  if (raw.length > MAX_CUSTOM_FIELD_VALUE_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'value', message: `must be ${MAX_CUSTOM_FIELD_VALUE_LENGTH} characters or fewer` },
    ]);
  }
  return raw;
}
