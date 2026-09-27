import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { GlossaryTermRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { GlossaryRepository } from './glossary.repository.js';

/**
 * Org glossary of terms (x263) — a studio's shared vocabulary. A member with the doc-authoring
 * capability adds a term, edits its definition, or removes it; any member who may read docs searches
 * and reads it. A shared, org-wide surface kept in its own table `glossary_terms` and its own module,
 * so it touches no file another docs slice appends to.
 *
 * ## Authorization
 *
 * The route guard asks the coarse question a guard can answer with no object loaded: the read routes
 * are `doc.read`, the write routes are `doc.write` — the doc-authoring capability the documents
 * controller already uses. A member without `doc.write` is refused at the guard (403) and never
 * reaches this service.
 *
 * A glossary term is org-wide, not scoped to a project, so there is no per-object relation gate. What
 * this service still does with a row in hand is the **resolve-before-act** order: a rename or delete
 * loads the term tenant-scoped **first**, so a missing id, or one that belongs to another studio, is a
 * **404** and no write is attempted. Uniqueness is enforced before the write too: a term that already
 * exists in the studio (case-insensitively) is a **409** and nothing is inserted, matching the
 * `(organization_id, term)` unique key that is the engine backstop.
 */

/** `glossary_terms.term` is `VARCHAR(190)`. */
export const MAX_TERM_LENGTH = 190;
/** `glossary_terms.definition` is `TEXT`; this keeps a comfortable ceiling below the 65_535-byte limit. */
export const MAX_DEFINITION_LENGTH = 4000;

/**
 * What a caller sees of one glossary term — paired Exact with the web's `GlossaryTermSummary`.
 * `organizationId` is deliberately absent — the wire projection never echoes the tenant id (`25-AUTH`
 * §7).
 */
export interface GlossaryTermView {
  readonly id: string;
  readonly term: string;
  readonly definition: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
  /** ISO-8601 instant. */
  readonly updatedAt: string;
}

function toView(row: GlossaryTermRow): GlossaryTermView {
  return {
    id: row.id,
    term: row.term,
    definition: row.definition,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class GlossaryService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly glossary: GlossaryRepository = new GlossaryRepository(),
  ) {}

  /**
   * Add a term. A term that already exists in the studio (case-insensitively) is a 409 and nothing is
   * inserted — the pre-read and the `(organization_id, term)` unique key agree. Runs in one
   * transaction so the check and the insert see one connection.
   */
  async create(
    context: TenantContext,
    input: { readonly term: string; readonly definition: string },
  ): Promise<GlossaryTermView> {
    const row = await this.database.transaction(context, async (tx) => {
      const existing = await this.glossary.findByTerm(tx, context, input.term);
      if (existing) {
        throw new ApiError(409, 'conflict', 'A term with that name already exists.');
      }
      return this.glossary.insert(tx, context, {
        term: input.term,
        definition: input.definition,
      });
    });
    return toView(row);
  }

  /**
   * Edit a term's text and/or definition. The term is resolved tenant-scoped **before** the write, so
   * a missing or cross-tenant id is a 404 (no write). A rename onto another existing term (again
   * case-insensitive) is a 409 and nothing changes.
   */
  async update(
    context: TenantContext,
    id: string,
    fields: { readonly term?: string; readonly definition?: string },
  ): Promise<GlossaryTermView> {
    const row = await this.database.transaction(context, async (tx) => {
      const current = await this.glossary.findById(tx, context, id);
      if (!current) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'glossary_term_not_found',
        );
      }
      if (fields.term !== undefined && fields.term !== current.term) {
        const clash = await this.glossary.findByTerm(tx, context, fields.term);
        if (clash && clash.id !== id) {
          throw new ApiError(409, 'conflict', 'A term with that name already exists.');
        }
      }
      const updated = await this.glossary.update(tx, context, id, fields);
      return updated as GlossaryTermRow;
    });
    return toView(row);
  }

  /**
   * Remove a term. Resolved tenant-scoped **before** the delete, so a missing or cross-tenant id is a
   * 404 (no write).
   */
  async remove(context: TenantContext, id: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const current = await this.glossary.findById(tx, context, id);
      if (!current) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'glossary_term_not_found',
        );
      }
      await this.glossary.remove(tx, context, id);
    });
  }

  /** List the studio's terms alphabetically, optionally filtered to a term prefix. */
  async list(context: TenantContext, query?: string): Promise<readonly GlossaryTermView[]> {
    const prefix = typeof query === 'string' ? query.trim() : undefined;
    const rows = await this.database.read(context, (runner) =>
      this.glossary.list(runner, context, prefix),
    );
    return rows.map(toView);
  }
}
