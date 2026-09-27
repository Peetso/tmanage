import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_CUSTOM_FIELDS_SERVICE } from '../../common/http/tokens.js';
import { PROJECT_CUSTOM_FIELD_TYPES } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ProjectCustomFieldsService } from './custom-fields.service.js';
import type {
  ProjectCustomFieldDefinitionView,
  ProjectCustomFieldValueView,
} from './custom-fields.service.js';
import type { ProjectCustomFieldType } from './custom-fields.repository.js';

/**
 * PROJ / module 8 (x310). Custom fields for projects.
 *
 * Two controllers, two authorization postures. Field **definitions** are org-scoped (no project in
 * the path), gated on `org.manage` and mounted at the static `…/projects/custom-fields` — matched
 * ahead of the `:projectId` param the way `…/projects/templates` is. Project **values** are gated on
 * `project.manage` and mounted under `…/projects/:projectId/custom-fields`; the service resolves the
 * project tenant-scoped before it authorizes or writes. Like every tenant-scoped controller here,
 * neither reads `organizationId` from the body, a header, or its own `:orgSlug` segment.
 */

interface DefineFieldBody {
  readonly key?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly options?: unknown;
}

interface SetValueBody {
  readonly value?: unknown;
}

function isFieldType(value: unknown): value is ProjectCustomFieldType {
  return (
    typeof value === 'string' && (PROJECT_CUSTOM_FIELD_TYPES as readonly string[]).includes(value)
  );
}

function parseOptions(
  raw: unknown,
  details: { field: string; message: string }[],
): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    details.push({ field: 'options', message: 'must be an array of strings' });
    return undefined;
  }
  if (raw.length > ProjectCustomFieldsService.limits.maxOptions) {
    details.push({
      field: 'options',
      message: `must have ${ProjectCustomFieldsService.limits.maxOptions} entries or fewer`,
    });
    return undefined;
  }
  const cleaned: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      details.push({ field: 'options', message: 'each entry must be a non-empty string' });
      return undefined;
    }
    const trimmed = entry.trim();
    if (trimmed.length > ProjectCustomFieldsService.limits.maxOptionLength) {
      details.push({
        field: 'options',
        message: `each entry must be ${ProjectCustomFieldsService.limits.maxOptionLength} characters or fewer`,
      });
      return undefined;
    }
    cleaned.push(trimmed);
  }
  return cleaned;
}

@Controller('v1/organizations/:orgSlug/projects/custom-fields')
export class ProjectCustomFieldDefinitionsController {
  constructor(
    @Inject(PROJECT_CUSTOM_FIELDS_SERVICE)
    private readonly fields: ProjectCustomFieldsService,
  ) {}

  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly definitions: readonly ProjectCustomFieldDefinitionView[] }> {
    return { definitions: await this.fields.listDefinitions(context, principal) };
  }

  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async define(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: DefineFieldBody,
  ): Promise<ProjectCustomFieldDefinitionView> {
    const key = ProjectCustomFieldsService.normalizeFieldKey(body?.key);
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;

    const details = [
      ...(key ? [] : [{ field: 'key', message: 'must be a non-empty lower_snake_case string' }]),
      ...(name ? [] : [{ field: 'name', message: 'must be a non-empty string' }]),
      ...(name && name.length > ProjectCustomFieldsService.limits.maxNameLength
        ? [
            {
              field: 'name',
              message: `must be ${ProjectCustomFieldsService.limits.maxNameLength} characters or fewer`,
            },
          ]
        : []),
      ...(isFieldType(body?.type)
        ? []
        : [{ field: 'type', message: `must be one of ${PROJECT_CUSTOM_FIELD_TYPES.join(', ')}` }]),
    ];
    const options = parseOptions(body?.options, details);

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!key || !name || !isFieldType(body?.type)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.fields.defineField(context, principal, {
      fieldKey: key,
      name,
      fieldType: body.type,
      ...(options === undefined ? {} : { options }),
    });
  }

  @Delete(':fieldKey')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fieldKey') fieldKey: string,
  ): Promise<void> {
    const key = ProjectCustomFieldsService.normalizeFieldKey(fieldKey);
    if (!key) {
      throw new ApiError(400, 'validation_failed', 'fieldKey is required', [
        { field: 'fieldKey', message: 'must be a non-empty lower_snake_case string' },
      ]);
    }
    await this.fields.deleteField(context, principal, key);
  }
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/custom-fields')
export class ProjectCustomFieldValuesController {
  constructor(
    @Inject(PROJECT_CUSTOM_FIELDS_SERVICE)
    private readonly fields: ProjectCustomFieldsService,
  ) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly fields: readonly ProjectCustomFieldValueView[] }> {
    if (typeof projectId !== 'string' || projectId === '') {
      throw new ApiError(400, 'validation_failed', 'projectId is required', [
        { field: 'projectId', message: 'must be a non-empty string' },
      ]);
    }
    return { fields: await this.fields.listValues(context, principal, projectId) };
  }

  @Put(':fieldKey')
  @RequireCapability('project.manage')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('fieldKey') fieldKey: string,
    @Body() body: SetValueBody,
  ): Promise<ProjectCustomFieldValueView> {
    const key = ProjectCustomFieldsService.normalizeFieldKey(fieldKey);
    const value = typeof body?.value === 'string' ? body.value : undefined;

    const details = [
      ...(projectId && typeof projectId === 'string'
        ? []
        : [{ field: 'projectId', message: 'must be a non-empty string' }]),
      ...(key
        ? []
        : [{ field: 'fieldKey', message: 'must be a non-empty lower_snake_case string' }]),
      ...(value !== undefined ? [] : [{ field: 'value', message: 'must be a string' }]),
      ...(value !== undefined && value.length > ProjectCustomFieldsService.limits.maxValueLength
        ? [
            {
              field: 'value',
              message: `must be ${ProjectCustomFieldsService.limits.maxValueLength} characters or fewer`,
            },
          ]
        : []),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!key || value === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.fields.setValue(context, principal, { projectId, fieldKey: key, value });
  }
}
