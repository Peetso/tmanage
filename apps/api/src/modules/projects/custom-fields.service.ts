import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectCustomFieldsRepository } from './custom-fields.repository.js';
import type { ProjectCustomFieldType } from './custom-fields.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type { ProjectCustomFieldRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x310) — custom fields for projects.
 *
 * ## Two surfaces, two authorization postures
 *
 * A *definition* belongs to the whole organization (there is no project in its path), so defining and
 * deleting one is gated on `org.manage` and re-checked against an **org-level** resource — the
 * `ProjectTemplatesService` posture. A *value* belongs to one project, so setting and reading values
 * is gated on `project.manage` and **relation-checked** with the row's project in hand — the
 * `ProjectStatusUpdatesService` posture.
 *
 * ## The Known-trap order (writes and the value read)
 *
 * Every value route names a project by id. The project is resolved **tenant-scoped before the
 * authorize check and the write**: an unknown or another tenant's id is a 404 (never a foreign-key
 * 500 — there is no FK on a value's project, so an unresolved id would otherwise write a dangling
 * row), and the relation failure is a 404 too (a 403 would confirm the project exists to a non-member).
 * A value's field is likewise resolved by key before the write, so an unknown field is a 404.
 */

/** A field definition, as a caller sees it. `organizationId` is deliberately absent. */
export interface ProjectCustomFieldDefinitionView {
  readonly fieldKey: string;
  readonly name: string;
  readonly fieldType: ProjectCustomFieldType;
  /** For a `select` field, the allowed options; `[]` otherwise. */
  readonly options: readonly string[];
}

/** One entry in a project's resolved field+value map: the definition plus the project's value (or null). */
export interface ProjectCustomFieldValueView {
  readonly fieldKey: string;
  readonly name: string;
  readonly fieldType: ProjectCustomFieldType;
  readonly options: readonly string[];
  /** The project's value for this field, or `null` when it has not been set. */
  readonly value: string | null;
}

function definitionToView(row: ProjectCustomFieldRow): ProjectCustomFieldDefinitionView {
  return {
    fieldKey: row.fieldKey,
    // A definition row always carries a name and type (the migration and the write path guarantee it);
    // the `??` narrows the nullable columns the shared table declares.
    name: row.name ?? row.fieldKey,
    fieldType: (row.fieldType ?? 'text') as ProjectCustomFieldType,
    options: row.optionsJson ?? [],
  };
}

const FIELD_KEY_PATTERN = /^[a-z0-9_]+$/;
const MAX_FIELD_KEY_LENGTH = 120;
const MAX_NAME_LENGTH = 200;
const MAX_VALUE_LENGTH = 20_000;
const MAX_OPTIONS = 100;
const MAX_OPTION_LENGTH = 200;

export class ProjectCustomFieldsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly fields: ProjectCustomFieldsRepository = new ProjectCustomFieldsRepository(),
    /**
     * Read-only, used to prove the project a value names exists **inside this tenant** before the write.
     * There is no composite foreign key on a value's project (see the migration), so without this
     * pre-resolution a missing or cross-tenant `projectId` would write a dangling value row.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /** Re-check `capability` at the org level (no project) with the real evaluator, or throw 403. */
  private authorizeOrg(context: TenantContext, principal: Principal, capability: Capability): void {
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, `denied_${capability}`);
    }
  }

  /**
   * Resolve a project the principal may manage, tenant- and relation-scoped, or throw the not-found
   * that an unknown id, a cross-tenant id, and a non-member's probe all earn.
   */
  private async requireManageableProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

  /** List the organization's field definitions. Gated on `org.manage`. */
  async listDefinitions(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly ProjectCustomFieldDefinitionView[]> {
    this.authorizeOrg(context, principal, 'org.manage');
    const rows = await this.database.read(context, (runner) =>
      this.fields.listDefinitions(runner, context),
    );
    return rows.map(definitionToView);
  }

  /**
   * Define a project custom field. Gated on `org.manage`. Empty key/name is a 400; a key already
   * defined in the tenant is a 409; a `select` field with no options is a 400.
   */
  async defineField(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly fieldKey: string;
      readonly name: string;
      readonly fieldType: ProjectCustomFieldType;
      readonly options?: readonly string[];
    },
  ): Promise<ProjectCustomFieldDefinitionView> {
    this.authorizeOrg(context, principal, 'org.manage');

    const options =
      input.fieldType === 'select' ? (input.options ?? []).map((o) => o.trim()) : undefined;
    if (input.fieldType === 'select' && (!options || options.length === 0)) {
      throw new ApiError(400, 'validation_failed', 'A select field must declare options', [
        { field: 'options', message: 'must be a non-empty array of strings' },
      ]);
    }

    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.fields.findDefinition(tx, context, input.fieldKey);
      if (existing) {
        throw new ApiError(409, 'conflict', 'A field with that key already exists', [
          { field: 'key', message: 'must be unique within the organization' },
        ]);
      }
      return this.fields.createDefinition(tx, context, {
        fieldKey: input.fieldKey,
        name: input.name,
        fieldType: input.fieldType,
        ...(options === undefined ? {} : { options }),
      });
    });
    return definitionToView(row);
  }

  /**
   * Delete a field definition by key. Gated on `org.manage`. An unknown key is a 404 (resolved first),
   * so a successful call always removed a definition.
   */
  async deleteField(context: TenantContext, principal: Principal, fieldKey: string): Promise<void> {
    this.authorizeOrg(context, principal, 'org.manage');
    await this.database.transaction(context, async (tx) => {
      const existing = await this.fields.findDefinition(tx, context, fieldKey);
      if (!existing) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'field_not_found');
      }
      await this.fields.deleteDefinition(tx, context, fieldKey);
    });
  }

  /**
   * Read a project's resolved field+value map. Gated on `project.manage`; the project is resolved
   * manage-visible first (Known-trap). Every defined field appears, with the project's value or null.
   */
  async listValues(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ProjectCustomFieldValueView[]> {
    await this.requireManageableProject(context, principal, projectId);

    const [definitions, values] = await this.database.read(context, async (runner) => {
      const defs = await this.fields.listDefinitions(runner, context);
      const vals = await this.fields.listValues(runner, context, projectId);
      return [defs, vals] as const;
    });

    const valueByKey = new Map(values.map((row) => [row.fieldKey, row.valueText ?? null]));
    return definitions.map((row) => {
      const view = definitionToView(row);
      return { ...view, value: valueByKey.get(row.fieldKey) ?? null };
    });
  }

  /**
   * Set a project's value for a field, idempotently. Gated on `project.manage`; the project is
   * resolved manage-visible first, then the field is resolved by key (an unknown field is a 404), then
   * the value is validated against the field type (`number` must parse; `select` must be one of the
   * options — a 400 otherwise), then upserted.
   */
  async setValue(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly fieldKey: string; readonly value: string },
  ): Promise<ProjectCustomFieldValueView> {
    await this.requireManageableProject(context, principal, input.projectId);

    const definition = await this.database.read(context, (runner) =>
      this.fields.findDefinition(runner, context, input.fieldKey),
    );
    if (!definition) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'field_not_found');
    }

    const value = input.value.trim();
    if (definition.fieldType === 'number' && !Number.isFinite(Number(value))) {
      throw new ApiError(400, 'validation_failed', 'The value must be a number', [
        { field: 'value', message: 'must be a number' },
      ]);
    }
    if (definition.fieldType === 'select' && !(definition.optionsJson ?? []).includes(value)) {
      throw new ApiError(400, 'validation_failed', 'The value must be one of the field options', [
        { field: 'value', message: 'must be one of the declared options' },
      ]);
    }

    const row = await this.database.transaction(context, (tx) =>
      this.fields.setValue(tx, context, {
        projectId: input.projectId,
        fieldKey: input.fieldKey,
        valueText: value,
      }),
    );
    return {
      ...definitionToView(definition),
      value: row.valueText ?? null,
    };
  }

  /** Validate a candidate field key: non-empty, `[a-z0-9_]+`, bounded. Returns the trimmed key or null. */
  static normalizeFieldKey(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.length > MAX_FIELD_KEY_LENGTH) return null;
    if (!FIELD_KEY_PATTERN.test(trimmed)) return null;
    return trimmed;
  }

  static readonly limits = {
    maxNameLength: MAX_NAME_LENGTH,
    maxValueLength: MAX_VALUE_LENGTH,
    maxOptions: MAX_OPTIONS,
    maxOptionLength: MAX_OPTION_LENGTH,
  } as const;
}
