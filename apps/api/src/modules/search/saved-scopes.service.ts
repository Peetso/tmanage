import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { SearchScopeFilters, SearchScopeRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { SearchIndexTargetKind } from './search-index.repository.js';
import { SearchScopesRepository } from './saved-scopes.repository.js';

/**
 * SRCH saved scopes (x334) — the application service.
 *
 * A member's named, reusable search **filter scopes** over one private, per-member table
 * (`search_scopes`): create, list, replace-in-place (idempotent PUT) and delete. A scope is a label
 * plus a filter set (`{ objectTypes[], projectId?, from?, to? }`) that pre-filters a search before it
 * runs — applying a scope just returns its filters to the search read (no new query engine, no new
 * ranking).
 *
 * ## Authorization
 *
 * The route ceiling is `search.use` (reused, no `capabilities.ts` edit); the object-level rule — a
 * member may read, edit and delete only their **own** scopes — is enforced here and in the repository,
 * which scopes every operation by `organization_id` AND `member_user_id`. A scope id that names
 * another member's row or another studio's row matches nothing and is a 404, never a leak that the row
 * exists.
 *
 * ## Validation
 *
 * The name is required (an empty one is a 400). Each `objectType` must be one of the search-index
 * kinds; an off-allowlist kind is a 400 with **no write**. A given `projectId` is resolved
 * tenant-scoped **before** the write (an unknown or cross-tenant id is a 400, no write). A scope name
 * unique per owner: a duplicate on create, or a rename onto another existing scope, is a 409.
 */

/** `search_scopes.name` is `VARCHAR(300)`. */
export const MAX_NAME_LENGTH = 300;
/** A scope narrows to a handful of object types, not an unbounded blob. */
export const MAX_OBJECT_TYPES = 10;

/**
 * The object kinds a scope may narrow to — the search-index type allowlist (`work_item`, `document`).
 * Held as a `satisfies` of {@link SearchIndexTargetKind}[] so it fails to compile if the indexed kinds
 * ever diverge, keeping the allowlist authoritative rather than a hand-copied literal.
 */
export const SCOPE_OBJECT_TYPES = [
  'work_item',
  'document',
] as const satisfies readonly SearchIndexTargetKind[];

/** A saved scope as the client reads it — paired Exact with the web's shape in the contracts gate. */
export interface SearchScopeView {
  readonly id: string;
  readonly name: string;
  readonly filters: SearchScopeFilters;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The validated create/replace body — request-side, so the contracts gate drops the `Input` suffix. */
export interface SearchScopeInput {
  readonly name: string;
  readonly filters: SearchScopeFilters;
}

export class SearchScopesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: SearchScopesRepository = new SearchScopesRepository(),
    /**
     * Read-only, used only to prove a given `projectId` filter names a project that exists **inside
     * this tenant** before a write, exactly as `SearchService` resolves a project before a search.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /** The acting member's scopes, newest first. */
  async list(context: TenantContext): Promise<readonly SearchScopeView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listOwned(runner, context),
    );
    return rows.map(toView);
  }

  /**
   * Create a new scope owned by the acting member. The filters are validated and the `projectId`
   * resolved tenant-scoped inside the transaction; a duplicate name is a 409 with no insert.
   */
  async create(context: TenantContext, input: SearchScopeInput): Promise<SearchScopeView> {
    const row = await this.database.transaction(context, async (tx) => {
      await this.resolveProject(tx, context, input.filters.projectId);
      const clash = await this.repository.findOwnedByName(tx, context, input.name);
      if (clash) throw new ApiError(409, 'conflict', 'A scope with that name already exists.');
      return this.repository.insert(tx, context, { name: input.name, filters: input.filters });
    });
    return toView(row);
  }

  /**
   * Replace one of the acting member's scopes in place (idempotent PUT). The scope is resolved
   * tenant- and owner-scoped **before** the write, so a missing or cross-tenant id is a 404 (no
   * write). A rename onto another existing scope is a 409.
   */
  async replace(
    context: TenantContext,
    id: string,
    input: SearchScopeInput,
  ): Promise<SearchScopeView> {
    const row = await this.database.transaction(context, async (tx) => {
      const current = await this.repository.findOwned(tx, context, id);
      if (!current) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      await this.resolveProject(tx, context, input.filters.projectId);
      if (input.name !== current.name) {
        const clash = await this.repository.findOwnedByName(tx, context, input.name);
        if (clash && clash.id !== id) {
          throw new ApiError(409, 'conflict', 'A scope with that name already exists.');
        }
      }
      const updated = await this.repository.updateOwned(tx, context, id, {
        name: input.name,
        filters: input.filters,
      });
      if (!updated) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return updated;
    });
    return toView(row);
  }

  /**
   * Delete the acting member's scope by id. Own-scoped: an id that names another member's row, another
   * studio's row or nothing removes nothing and is a 404 — a scope's existence is never disclosed to
   * anyone but its owner.
   */
  async remove(context: TenantContext, id: string): Promise<void> {
    const removed = await this.database.transaction(context, (tx) =>
      this.repository.deleteOwned(tx, context, id),
    );
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  /**
   * Resolve an optional project filter inside the tenant before a write. A given id that names no
   * project in this studio (or another studio's) is a 400 with no write — the honest answer, never an
   * empty set that hides "not your project".
   */
  private async resolveProject(
    runner: Parameters<ProjectsRepository['findById']>[0],
    context: TenantContext,
    projectId: string | undefined,
  ): Promise<void> {
    if (projectId === undefined) return;
    const project = await this.projects.findById(runner, context, projectId);
    if (!project) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'filters.projectId', message: 'must name a project in this organization' },
      ]);
    }
  }
}

function toView(row: SearchScopeRow): SearchScopeView {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
