import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { FocusBlockRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { FocusBlocksRepository } from './focus-blocks.repository.js';

/**
 * CAL-04 focus blocks (x255) — a member creates protected time on their calendar, lists their blocks
 * in a bounded window, and deletes one. A per-membership surface kept in its own table `focus_blocks`
 * and its own module, so it touches no file another calendar slice appends to.
 *
 * ## Own blocks only, and the capability reused rather than invented
 *
 * There is no membership in the path: the subject is the authenticated `principal`'s membership
 * (`context.membershipId`), so no caller can create, read, or delete another member's blocks — the
 * request has no way to name one. The route capability is **`work.read`** (own personal calendar), the
 * same own-principal choice the sibling preferences slices (quiet-hours x215, widget-prefs x243) make:
 * `12-PERMISSION-MATRIX` names no personal-calendar capability, `work.read` is the one every internal
 * role holds and no client role does, and the pass forbids editing `capabilities.ts`.
 *
 * ## The delete resolves ownership before it acts
 *
 * {@link remove} deletes only a row that is both this tenant's and this membership's: the repository
 * resolves `(organization_id, id, membership_id)` first, so an id that names another member's block —
 * or one that does not exist — is a **404** with no delete, never a cross-member removal.
 */

/**
 * What a caller sees of one focus block — paired Exact with the web's `FocusBlockView`.
 * `organizationId`/`membershipId` are deliberately absent — the wire projection never echoes the
 * tenant id (`25-AUTH` §7), and the membership is always the caller's own.
 */
export interface FocusBlockView {
  readonly id: string;
  /** ISO-8601 instant. */
  readonly startsAt: string;
  /** ISO-8601 instant. */
  readonly endsAt: string;
  readonly title: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/** A well-formed create request, after the controller has validated the body. */
export interface CreateFocusBlock {
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly title: string;
}

export class FocusBlocksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly blocks: FocusBlocksRepository = new FocusBlocksRepository(),
  ) {}

  /** Create a focus block for the caller. The body is already validated by the controller. */
  async create(
    context: TenantContext,
    _principal: Principal,
    input: CreateFocusBlock,
  ): Promise<FocusBlockView> {
    const row = await this.database.transaction(context, (tx) =>
      this.blocks.create(tx, context, {
        membershipId: context.membershipId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        title: input.title,
      }),
    );
    return viewOf(row);
  }

  /** List the caller's blocks that start within `[from, to)`, earliest first. */
  async list(
    context: TenantContext,
    _principal: Principal,
    from: Date,
    to: Date,
  ): Promise<readonly FocusBlockView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.blocks.listForMember(runner, context, context.membershipId, from, to),
    );
    return rows.map(viewOf);
  }

  /**
   * Delete one of the caller's blocks. Resolves ownership `(tenant, id, membership)` first, so an id
   * that names another member's block or none at all is a 404 with no delete.
   */
  async remove(context: TenantContext, _principal: Principal, id: string): Promise<void> {
    const removed = await this.database.transaction(context, (tx) =>
      this.blocks.deleteOwn(tx, context, id, context.membershipId),
    );
    if (!removed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'focus_block_not_found');
    }
  }
}

function viewOf(row: FocusBlockRow): FocusBlockView {
  return {
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    title: row.title,
    createdAt: row.createdAt.toISOString(),
  };
}
