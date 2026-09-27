import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { GlossaryService, MAX_DEFINITION_LENGTH, MAX_TERM_LENGTH } from './glossary.service.js';
import type { GlossaryTermView } from './glossary.service.js';

/**
 * Org glossary of terms (x263). Add a term, edit it, remove it, and search the glossary. Like every
 * tenant-scoped controller here it never reads `organizationId` from the body, a header, or its
 * `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built from a
 * membership row and passes it on. Reads are `doc.read`; writes are `doc.write`, the doc-authoring
 * capability the documents controller already uses. The controller lives in its own module
 * (registered in `app.module.ts`) so the slice touches no file another docs slice appends to.
 */

const GLOSSARY_SERVICE = Symbol.for('tmanage.GlossaryService');

interface WriteTermBody {
  readonly term?: unknown;
  readonly definition?: unknown;
}

@Controller('v1/organizations/:orgSlug/glossary/terms')
export class GlossaryController {
  constructor(@Inject(GLOSSARY_SERVICE) private readonly glossary: GlossaryService) {}

  /** Search / list the studio's glossary, alphabetically. `q` filters to a term prefix. `doc.read`. */
  @Get()
  @RequireCapability('doc.read')
  async list(
    @Ctx() context: TenantContext,
    @Query('q') q?: string,
  ): Promise<{ readonly terms: readonly GlossaryTermView[] }> {
    return { terms: await this.glossary.list(context, typeof q === 'string' ? q : undefined) };
  }

  /** Add a term. `doc.write`. A duplicate term (case-insensitive) is a 409, no second row. */
  @Post()
  @RequireCapability('doc.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @Body() body: WriteTermBody,
  ): Promise<GlossaryTermView> {
    const term = typeof body?.term === 'string' ? body.term.trim() : undefined;
    const definition = typeof body?.definition === 'string' ? body.definition.trim() : undefined;

    const details = [
      ...requiredString('term', term, MAX_TERM_LENGTH),
      ...requiredString('definition', definition, MAX_DEFINITION_LENGTH),
    ];
    if (details.length > 0 || term === undefined || definition === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.glossary.create(context, { term, definition });
  }

  /** Edit a term and/or its definition. `doc.write`. Resolved tenant-scoped before the write (404). */
  @Patch(':id')
  @RequireCapability('doc.write')
  async update(
    @Ctx() context: TenantContext,
    @Param('id') id: string,
    @Body() body: WriteTermBody,
  ): Promise<GlossaryTermView> {
    requireId(id);

    const term =
      body?.term === undefined
        ? undefined
        : typeof body.term === 'string'
          ? body.term.trim()
          : null;
    const definition =
      body?.definition === undefined
        ? undefined
        : typeof body.definition === 'string'
          ? body.definition.trim()
          : null;

    const details = [
      ...(term === null || (typeof term === 'string' && term === '')
        ? [{ field: 'term', message: 'must be a non-empty string' }]
        : []),
      ...(typeof term === 'string' && term.length > MAX_TERM_LENGTH
        ? [{ field: 'term', message: `must be ${MAX_TERM_LENGTH} characters or fewer` }]
        : []),
      ...(definition === null || (typeof definition === 'string' && definition === '')
        ? [{ field: 'definition', message: 'must be a non-empty string' }]
        : []),
      ...(typeof definition === 'string' && definition.length > MAX_DEFINITION_LENGTH
        ? [{ field: 'definition', message: `must be ${MAX_DEFINITION_LENGTH} characters or fewer` }]
        : []),
    ];
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    if (term === undefined && definition === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'term', message: 'at least one of term or definition is required' },
      ]);
    }

    return this.glossary.update(context, id, {
      ...(term !== undefined && term !== null ? { term } : {}),
      ...(definition !== undefined && definition !== null ? { definition } : {}),
    });
  }

  /** Remove a term. `doc.write`. Resolved tenant-scoped before the delete (404). */
  @Delete(':id')
  @RequireCapability('doc.write')
  @HttpCode(204)
  async remove(@Ctx() context: TenantContext, @Param('id') id: string): Promise<void> {
    requireId(id);
    await this.glossary.remove(context, id);
  }
}

/** Shared required-string validation: present, non-empty, within the column ceiling. */
function requiredString(
  field: string,
  value: string | undefined,
  max: number,
): readonly { field: string; message: string }[] {
  if (value === undefined || value === '') {
    return [{ field, message: 'must be a non-empty string' }];
  }
  if (value.length > max) {
    return [{ field, message: `must be ${max} characters or fewer` }];
  }
  return [];
}

/** A path `id` is always required and always a non-empty string. */
function requireId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id === '') {
    throw new ApiError(400, 'validation_failed', 'id is required', [
      { field: 'id', message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * Org glossary of terms (x263). The module that wires the controller and its service. Registered in
 * `app.module.ts` rather than folded into `DocsModule`, so this slice touches no file another docs
 * slice in the same pass appends to; it depends only on the global tenant database.
 */
@Module({})
export class GlossaryModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: GLOSSARY_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new GlossaryService(database),
    };

    return {
      module: GlossaryModule,
      providers: [service],
      controllers: [GlossaryController],
    };
  }
}
