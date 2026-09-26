import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocumentTemplateVariableRow } from '../../common/database/schema.js';
import { DocumentTemplatesRepository } from './document-templates.repository.js';
import {
  DocumentTemplateVariableKeyConflictError,
  DocumentTemplateVariablesRepository,
} from './document-template-variables.repository.js';
import type {
  DocumentTemplateVariableType,
  ListDocumentTemplateVariablesOptions,
} from './document-template-variables.repository.js';

/**
 * DOC-04 (x130). The service and controller for a document template's declared variables —
 * add/list/remove the named placeholders a template exposes (DOC-04's variable half, deferred from
 * NS-11). Substitution at render and defaults are deferred (NS-13).
 *
 * The service is co-located here (with the module that wires it) rather than in a separate file
 * because it is small and the slice adds no other consumer of it. It follows `DocumentsService`'s
 * two-layer shape exactly: the route guard asks the coarse `doc.read`/`doc.write` question, and this
 * service adds the authoritative application decision — resolving the parent template tenant-scoped
 * *before* it authorizes or writes (the Known-trap order), then authorizing `work.read`/`work.create`
 * org-scoped (the sibling capabilities `doc.read`/`doc.write` mirror by construction; see
 * `DocumentsService`'s class comment).
 */

/** What a caller is allowed to see of one template variable. `organizationId` is deliberately absent. */
export interface DocumentTemplateVariableView {
  readonly id: string;
  readonly templateId: string;
  readonly key: string;
  readonly label: string;
  readonly type: DocumentTemplateVariableType;
  readonly required: boolean;
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: DocumentTemplateVariableRow): DocumentTemplateVariableView {
  return {
    id: row.id,
    templateId: row.templateId,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    createdAt: row.createdAt.toISOString(),
  };
}

export class DocumentTemplateVariablesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly variables: DocumentTemplateVariablesRepository = new DocumentTemplateVariablesRepository(),
    private readonly templates: DocumentTemplatesRepository = new DocumentTemplatesRepository(),
  ) {}

  /**
   * Resolve the parent template tenant-scoped, **before** any authorize or write.
   *
   * This is the Known-trap order (FAST-PROTOCOL 19:55): a missing `templateId`, or one that belongs
   * to another tenant, returns null from the tenant-scoped read and becomes a **404** here, never a
   * foreign-key 500 reached by an org-wide caller who would pass the authorize below regardless.
   */
  private async requireTemplate(context: TenantContext, templateId: string): Promise<void> {
    const template = await this.database.read(context, (runner) =>
      this.templates.findById(runner, context, templateId),
    );
    if (!template) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'template_not_visible');
    }
  }

  /** Authorize an org-scoped read/write of templates (`projectId: null`), or throw 403. */
  private requireAuthorized(
    principal: Principal,
    context: TenantContext,
    capability: 'work.read' | 'work.create',
    logCode: string,
  ): void {
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
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, logCode);
    }
  }

  /**
   * Add a variable to a template. Resolves the template tenant-scoped (404) before it authorizes
   * (`work.create`, 403) and before it writes. A key the template already declares is a 409.
   */
  async add(
    context: TenantContext,
    principal: Principal,
    templateId: string,
    input: {
      readonly key: string;
      readonly label: string;
      readonly type: DocumentTemplateVariableType;
      readonly required: boolean;
    },
  ): Promise<DocumentTemplateVariableView> {
    await this.requireTemplate(context, templateId);
    this.requireAuthorized(principal, context, 'work.create', 'template_variable_write_denied');

    try {
      const row = await this.database.transaction(context, (tx) =>
        this.variables.create(tx, context, { templateId, ...input }),
      );
      return toView(row);
    } catch (error) {
      if (error instanceof DocumentTemplateVariableKeyConflictError) {
        throw new ApiError(
          409,
          'conflict',
          'A variable with that key already exists on this template',
          [{ field: 'key', message: 'must be unique within the template' }],
          'template_variable_key_conflict',
        );
      }
      throw error;
    }
  }

  /**
   * List a template's variables, key-ascending, for a caller who may read. Resolves the template
   * tenant-scoped (404) before it authorizes (`work.read`, 403).
   */
  async list(
    context: TenantContext,
    principal: Principal,
    templateId: string,
    options: ListDocumentTemplateVariablesOptions = {},
  ): Promise<readonly DocumentTemplateVariableView[]> {
    await this.requireTemplate(context, templateId);
    this.requireAuthorized(principal, context, 'work.read', 'template_variable_read_denied');

    const rows = await this.database.read(context, (runner) =>
      this.variables.list(runner, context, templateId, options),
    );
    return rows.map(toView);
  }

  /**
   * Remove a variable. Resolves the template and the variable tenant-scoped (both 404 if missing or
   * cross-tenant, no write) before it authorizes (`work.create`, 403) and before it deletes.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    templateId: string,
    variableId: string,
  ): Promise<void> {
    await this.requireTemplate(context, templateId);

    const variable = await this.database.read(context, (runner) =>
      this.variables.findById(runner, context, templateId, variableId),
    );
    if (!variable) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'variable_not_visible');
    }

    this.requireAuthorized(principal, context, 'work.create', 'template_variable_write_denied');

    await this.database.transaction(context, (tx) =>
      this.variables.deleteById(tx, context, templateId, variableId),
    );
  }
}

/** `document_template_variables.key` is `VARCHAR(120)`. */
const MAX_KEY_LENGTH = 120;
/** `document_template_variables.label` is `VARCHAR(300)`. */
const MAX_LABEL_LENGTH = 300;
const VARIABLE_TYPES: readonly DocumentTemplateVariableType[] = ['text', 'date', 'number'];

/** DI token for the co-located service, so no `tokens.ts` edit is needed for this slice. */
const DOCUMENT_TEMPLATE_VARIABLES_SERVICE = Symbol.for('tmanage.DocumentTemplateVariablesService');

/** DOC-04 add-a-variable request body. */
interface AddVariableBody {
  readonly key?: unknown;
  readonly label?: unknown;
  readonly type?: unknown;
  readonly required?: unknown;
}

@Controller('v1/organizations/:orgSlug/document-templates/:templateId/variables')
export class DocumentTemplateVariablesController {
  constructor(
    @Inject(DOCUMENT_TEMPLATE_VARIABLES_SERVICE)
    private readonly variables: DocumentTemplateVariablesService,
  ) {}

  /** DOC-04. List a template's variables, key-ascending. `doc.read`. */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly variables: readonly DocumentTemplateVariableView[] }> {
    requireTemplateId(templateId);
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }
    return {
      variables: await this.variables.list(context, principal, templateId, {
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  /** DOC-04. Add a variable to a template. `doc.write`. */
  @Post()
  @RequireCapability('doc.write')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Body() body: AddVariableBody,
  ): Promise<DocumentTemplateVariableView> {
    requireTemplateId(templateId);

    const key = typeof body?.key === 'string' ? body.key.trim() : undefined;
    const label = typeof body?.label === 'string' ? body.label.trim() : undefined;
    const type = typeof body?.type === 'string' ? body.type : 'text';
    const required = typeof body?.required === 'boolean' ? body.required : false;

    const details = [
      ...(key ? [] : [{ field: 'key', message: 'must be a non-empty string' }]),
      ...(key && key.length > MAX_KEY_LENGTH
        ? [{ field: 'key', message: `must be ${MAX_KEY_LENGTH} characters or fewer` }]
        : []),
      ...(label ? [] : [{ field: 'label', message: 'must be a non-empty string' }]),
      ...(label && label.length > MAX_LABEL_LENGTH
        ? [{ field: 'label', message: `must be ${MAX_LABEL_LENGTH} characters or fewer` }]
        : []),
      ...(VARIABLE_TYPES.includes(type as DocumentTemplateVariableType)
        ? []
        : [{ field: 'type', message: `must be one of ${VARIABLE_TYPES.join(', ')}` }]),
    ];

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    // Narrowed by the `details.length` check above, which TypeScript cannot see through.
    if (!key || !label || !VARIABLE_TYPES.includes(type as DocumentTemplateVariableType)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.variables.add(context, principal, templateId, {
      key,
      label,
      type: type as DocumentTemplateVariableType,
      required,
    });
  }

  /** DOC-04. Remove a variable, tenant- and template-scoped. `doc.write`. */
  @Delete(':variableId')
  @RequireCapability('doc.write')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
    @Param('variableId') variableId: string,
  ): Promise<void> {
    requireTemplateId(templateId);
    if (typeof variableId !== 'string' || variableId === '') {
      throw new ApiError(400, 'validation_failed', 'variableId is required', [
        { field: 'variableId', message: 'must be a non-empty string' },
      ]);
    }
    await this.variables.remove(context, principal, templateId, variableId);
  }
}

/** A path `templateId` is always required and always a non-empty string. */
function requireTemplateId(templateId: unknown): asserts templateId is string {
  if (typeof templateId !== 'string' || templateId === '') {
    throw new ApiError(400, 'validation_failed', 'templateId is required', [
      { field: 'templateId', message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * DOC-04 (x130). The module that wires the controller and its co-located service. Registered in
 * `app.module.ts` rather than folded into `DocsModule`, so this slice touches no file another docs
 * slice in the same pass appends to.
 */
@Module({})
export class DocumentTemplateVariablesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: DOCUMENT_TEMPLATE_VARIABLES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new DocumentTemplateVariablesService(database),
    };

    return {
      module: DocumentTemplateVariablesModule,
      providers: [service],
      controllers: [DocumentTemplateVariablesController],
    };
  }
}
