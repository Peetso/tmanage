import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  INBOX_MUTE_OBJECT_TYPES,
  type InboxMuteObjectType,
  type InboxSourceMutesRepository,
} from './source-mutes.repository.js';

/** The DI token for the inbox source-mutes service — module-local (wired in `inbox.module.ts`). */
export const INBOX_SOURCE_MUTES_SERVICE = Symbol('tmanage.InboxModule.SourceMutesService');

/**
 * x318's response projection — the caller's muted sources, each row inlined, so the API↔web pairing
 * is this single shape. `createdAt` is an ISO string, the shape `JSON.stringify` emits on the wire.
 */
export interface InboxSourceMutesView {
  readonly mutes: readonly {
    readonly objectType: InboxMuteObjectType;
    readonly objectId: string;
    readonly createdAt: string;
  }[];
}

/** The largest an object id may be — the width of `inbox_source_mutes.object_id`. */
const OBJECT_ID_MAX = 64;

/**
 * INBOX source mutes (x318) — a member mutes a specific source object so its bundle is filtered out
 * of *their* inbox read, un-mutes it, and lists their mutes.
 *
 * ## What this service is
 *
 * A self-scoped read-side filter. It changes no dispatch: a muted source's notifications are still
 * written and counted; only the member's inbox composition excludes the muted `(objectType,
 * objectId)` pairs (via {@link listForMember}, an additive helper the integrator wires where the
 * bundle is composed — the inbox core is untouched this slice).
 *
 * ## The one safety rule this service is
 *
 * The object_type must be in the inbox object-type allowlist ({@link INBOX_MUTE_OBJECT_TYPES}), and
 * the object_id a non-empty string within the column width — an off-allowlist type or a malformed id
 * is a 400 with **no insert** (the refusal this slice proves). Owner is always the caller: every
 * read, the insert and the delete are scoped by `context.userId` (`TenantContextGuard`'s, never a
 * value a route supplies), so a member can only ever read, add or remove their own mutes, and a GET
 * never returns another member's rows. Muting is idempotent — the service resolves an existing mute
 * as a no-op rather than a conflict — and un-muting is idempotent too (204 whether or not a row was
 * removed). The capability gate (`work.read`) is the controller's `@RequireCapability`.
 */
export class InboxSourceMutesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: InboxSourceMutesRepository,
  ) {}

  /**
   * Mute one source for the acting member. Validates the object_type against the allowlist and the
   * object_id (400, no insert), then inserts if the member has not already muted it (idempotent).
   * Both arrive as `unknown` and are validated here. Returns the caller's mutes after the write.
   */
  async mute(
    context: TenantContext,
    objectType: unknown,
    objectId: unknown,
  ): Promise<InboxSourceMutesView> {
    const type = parseObjectType(objectType);
    const id = parseObjectId(objectId);

    await this.database.transaction(context, async (tx) => {
      const existing = await this.repository.findOwn(tx, context, context.userId, type, id);
      if (existing) return; // Idempotent: re-muting the same source is a no-op, not a conflict.
      await this.repository.insert(tx, context, context.userId, type, id);
    });

    return this.listOwn(context);
  }

  /**
   * Un-mute one source (204). Own-scoped and idempotent: the delete is scoped by the acting member,
   * so a source another member muted (or one nobody muted) removes nothing and the route still
   * answers 204 — a mute's existence is never disclosed to a member it is not for. The object_type
   * and object_id are validated the same way (400, no delete) so a malformed request is refused, not
   * silently swallowed.
   */
  async unmute(context: TenantContext, objectType: unknown, objectId: unknown): Promise<void> {
    const type = parseObjectType(objectType);
    const id = parseObjectId(objectId);
    await this.database.transaction(context, (tx) =>
      this.repository.deleteOwn(tx, context, context.userId, type, id),
    );
  }

  /** The acting member's muted sources (200). */
  async list(context: TenantContext): Promise<InboxSourceMutesView> {
    return this.listOwn(context);
  }

  private async listOwn(context: TenantContext): Promise<InboxSourceMutesView> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listForMember(runner, context, context.userId),
    );
    return {
      mutes: rows.map((row) => ({
        objectType: row.objectType as InboxMuteObjectType,
        objectId: row.objectId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }
}

/**
 * `objectType` as one of the inbox object-type allowlist, or a 400 with no write — the refusal this
 * slice proves. A missing, non-string or off-allowlist value is rejected before any repository call.
 */
function parseObjectType(objectType: unknown): InboxMuteObjectType {
  if (
    typeof objectType === 'string' &&
    (INBOX_MUTE_OBJECT_TYPES as readonly string[]).includes(objectType)
  ) {
    return objectType as InboxMuteObjectType;
  }
  throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field: 'objectType', message: `must be one of ${INBOX_MUTE_OBJECT_TYPES.join(', ')}` },
  ]);
}

/**
 * `objectId` as a non-empty string within the column width, or a 400 with no write. A missing,
 * non-string, empty or over-long id is rejected before any repository call, so a malformed source
 * can never reach the row (and never provoke a data-too-long 500 at the engine).
 */
function parseObjectId(objectId: unknown): string {
  if (typeof objectId === 'string' && objectId.length > 0 && objectId.length <= OBJECT_ID_MAX) {
    return objectId;
  }
  throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
    {
      field: 'objectId',
      message: `must be a non-empty string of at most ${OBJECT_ID_MAX} characters`,
    },
  ]);
}
