import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InboxFlagRepository } from './inbox-flag.repository.js';

/**
 * INBOX-001 IN-01 "Important inbox" (x260) — flag (star) an inbox bundle as important, unflag it, and
 * list a member's flagged bundles.
 *
 * ## Ownership is re-checked before the write, exactly where `markBundleRead` re-checks it
 *
 * A bundle id is the inbox's own `objectType:objectId`. Before a flag is written, the service resolves
 * the bundle's ownership the way the read surface does — a bundle is the caller's iff a notification
 * addressed to them (`principal.userId`) about that object exists in this tenant — and a bundle that is
 * not theirs is a **404 with no insert**, never a "you cannot flag this" that would confirm the object
 * exists. This is the reauthorization `35-NOTIFICATION-AND-EMAIL-COPY` §1 asks for, at the flag action.
 *
 * ## The flag is per membership, self-scoped, and idempotent
 *
 * The subject is always `principal.membershipId` — the request has no path or query that could name
 * another membership — so a member flags, unflags and lists only their own. A repeated PUT is one row
 * (the unique key), a DELETE of a bundle that is not flagged is a 204 no-op, and the flagged list is a
 * projection of the caller's own rows.
 */

/** What the flag routes exchange for a single bundle: the bundle id and its flagged state. */
export interface InboxFlagView {
  readonly bundleId: string;
  readonly flagged: boolean;
}

/** A member's "Important" view: the bundle ids they have flagged, newest first. */
export interface InboxFlaggedView {
  readonly bundleIds: readonly string[];
}

/** The bundle object types a flag can name — the inbox's object bundles (never the usage notice). */
const FLAGGABLE_OBJECT_TYPES: readonly string[] = ['work_item', 'client_request'];

export class InboxFlagService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly flags: InboxFlagRepository,
  ) {}

  /**
   * Flag a bundle as important for the caller. Resolves ownership first — a bundle the caller has no
   * notification for is a 404 and nothing is written — then inserts idempotently.
   */
  async flag(
    context: TenantContext,
    principal: Principal,
    bundleId: string,
  ): Promise<InboxFlagView> {
    const parsed = parseBundleId(bundleId);
    if (!parsed) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    const owned = await this.database.read(context, (runner) =>
      this.flags.hasNotificationForRecipient(
        runner,
        context,
        principal.userId,
        parsed.objectType,
        parsed.objectId,
      ),
    );
    if (!owned) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    await this.database.transaction(context, (tx) =>
      this.flags.add(tx, context, principal.membershipId, bundleId),
    );
    return { bundleId, flagged: true };
  }

  /**
   * Unflag a bundle for the caller. Scoped to `principal.membershipId`, so it can only ever remove the
   * caller's own flag; idempotent — a bundle that is not flagged (or an id that was never a valid
   * bundle, and so was never inserted) removes nothing and is a 204 all the same.
   */
  async unflag(context: TenantContext, principal: Principal, bundleId: string): Promise<void> {
    await this.database.transaction(context, (tx) =>
      this.flags.remove(tx, context, principal.membershipId, bundleId),
    );
  }

  /** The caller's flagged bundle ids, newest first — their own rows and nothing else. */
  async listFlagged(context: TenantContext, principal: Principal): Promise<InboxFlaggedView> {
    const bundleIds = await this.database.read(context, (runner) =>
      this.flags.listForMembership(runner, context, principal.membershipId),
    );
    return { bundleIds };
  }
}

/**
 * Parse a flaggable bundle id into `objectType:objectId`. Only the inbox's object bundles are
 * flaggable (`work_item`, `client_request`); the organization-usage notice and any malformed id are
 * not a bundle a member stars, and resolve to `null` — the caller's 404.
 */
function parseBundleId(
  bundleId: string,
): { readonly objectType: string; readonly objectId: string } | null {
  const separator = bundleId.indexOf(':');
  if (separator <= 0) return null;
  const objectType = bundleId.slice(0, separator);
  const objectId = bundleId.slice(separator + 1);
  if (!FLAGGABLE_OBJECT_TYPES.includes(objectType)) return null;
  if (objectId === '') return null;
  return { objectType, objectId };
}
