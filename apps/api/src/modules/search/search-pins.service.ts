import { ApiError } from '../../common/http/errors.js';
import type { SearchPinRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SearchPinsRepository } from './search-pins.repository.js';

/**
 * SRCH quick-access pins (x290) — the application service.
 *
 * A member pins an indexed entity for quick access, lists their pins, and unpins. A pin is a bare
 * **type + id reference** with a cached display `label`; it holds no copy of the entity, so the
 * screen (and any future resolver) reads the target's own read side later — a pin to an object the
 * caller may no longer read renders as unavailable and never leaks.
 *
 * The route ceiling is `search.use` (reused, no `capabilities.ts` edit); the object-level rule — a
 * member may read and unpin only their **own** pins — is enforced here and in the repository, which
 * scopes every operation by `organization_id` AND `membership_id`. A pin id that names another
 * member's row or another studio's row matches nothing: the listing omits it and the unpin no-ops.
 */

/**
 * The fixed indexed-entity allowlist a pin's `objectType` must name. These are the searchable /
 * indexed kinds a member reaches from the Search module — the `SearchResultKind` set (work item,
 * document, meeting) plus `project`. A value off this list is refused with a 400 before any write,
 * so the column only ever holds a known kind and a pin cannot be minted against an arbitrary string.
 */
export const SEARCH_PIN_OBJECT_TYPES = ['work_item', 'document', 'meeting', 'project'] as const;
export type SearchPinObjectType = (typeof SEARCH_PIN_OBJECT_TYPES)[number];

/** A pin as the client reads it — paired Exact with the web's `SearchPin` in the contracts gate. */
export interface SearchPinView {
  readonly id: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly label: string;
  readonly createdAt: string;
}

/** The validated pin body — request-side, so the contracts gate drops the `Input` suffix. */
export interface PinInput {
  readonly objectType: SearchPinObjectType;
  readonly objectId: string;
  readonly label: string;
}

export class SearchPinsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: SearchPinsRepository = new SearchPinsRepository(),
  ) {}

  /** The acting member's pins, newest first. */
  async list(context: TenantContext): Promise<readonly SearchPinView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listPins(runner, context),
    );
    return rows.map((row) => toView(row));
  }

  /**
   * Pin an entity for the acting member, idempotently. Refuses an `objectType` off the fixed
   * allowlist with a 400 before any write (no insert). A repeat pin of the same target refreshes its
   * label rather than adding a row.
   */
  async pin(context: TenantContext, input: PinInput): Promise<SearchPinView> {
    if (!isAllowedObjectType(input.objectType)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'objectType', message: 'must be a supported entity type' },
      ]);
    }
    const row = await this.database.transaction(context, (tx) =>
      this.repository.upsertPin(tx, context, {
        objectType: input.objectType,
        objectId: input.objectId,
        label: input.label,
      }),
    );
    return toView(row);
  }

  /**
   * Unpin the acting member's pin by id. Own-scoped and idempotent: an id that names another
   * member's pin, another studio's pin, or nothing removes nothing and still answers 204 — a pin is
   * private, so its existence is never disclosed to anyone but its owner.
   */
  async unpin(context: TenantContext, id: string): Promise<void> {
    await this.database.transaction(context, (tx) => this.repository.deleteOwned(tx, context, id));
  }
}

/** A runtime allowlist check that also narrows the type for the caller. */
export function isAllowedObjectType(value: unknown): value is SearchPinObjectType {
  return (
    typeof value === 'string' && (SEARCH_PIN_OBJECT_TYPES as readonly string[]).includes(value)
  );
}

/** Project a row to the wire shape. */
function toView(row: SearchPinRow): SearchPinView {
  return {
    id: row.id,
    objectType: row.objectType,
    objectId: row.objectId,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  };
}
