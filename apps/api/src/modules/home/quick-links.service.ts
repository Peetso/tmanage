import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { HomeQuickLinksRepository } from './quick-links.repository.js';

/**
 * Home quick links service (module 4 Home / My Day, x273).
 *
 * The orchestration and the safety live here, in one place the controller test drives directly:
 *
 * - **Own-membership only.** Every method takes the acting `membershipId` from the caller (the
 *   controller passes `context.membershipId`, never a body value), and the repository scopes every
 *   read and write by it, so a member only ever sees or changes their own links.
 * - **Open-redirect guard.** {@link parseCreateInput} refuses a `path` that is not a leading-slash,
 *   scheme-less, same-origin in-app path — an absolute `http(s)://` URL, a protocol-relative `//host`
 *   or a backslash-bearing path is a 400 and nothing is written, so a saved quick link can never
 *   point off-site.
 * - **Bounded.** The count is capped at {@link MAX_QUICK_LINKS}; a further add is a 409, so a
 *   member's list stays small.
 * - **Reorder allowlists existing ids only.** {@link reorder} accepts an ordering that is exactly a
 *   permutation of the caller's current link ids; any unknown id, duplicate or omission is a 400 and
 *   nothing is written, so a reorder can never introduce, drop or cite a foreign link.
 */

/** The most quick links one member may keep — a further add is a 409. */
export const MAX_QUICK_LINKS = 20;

/** The longest a stored `path` may be, matching the column width. */
const MAX_PATH_LENGTH = 512;
/** The longest a stored `label` may be, matching the column width. */
const MAX_LABEL_LENGTH = 200;

/** One quick link as the API exchanges it — a row projected, position kept for a stable client order. */
export interface HomeQuickLinkItem {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly position: number;
}

/** The caller's quick links, in position order. Paired Exact with the web view. */
export interface HomeQuickLinksView {
  readonly links: readonly HomeQuickLinkItem[];
}

/** A validated create input: a non-empty label and a safe relative in-app path. */
interface CreateInput {
  readonly label: string;
  readonly path: string;
}

export class HomeQuickLinksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: HomeQuickLinksRepository,
  ) {}

  /** List the acting membership's quick links, in position order (200). */
  async list(context: TenantContext, membershipId: string): Promise<HomeQuickLinksView> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listForMembership(runner, context, membershipId),
    );
    return project(rows);
  }

  /**
   * Add a quick link. The body is validated (non-empty label, safe in-app path) before any write;
   * the count is capped at {@link MAX_QUICK_LINKS} (a further add is a 409); the new link is appended
   * after the caller's current links. Returns the caller's links after the add (201).
   */
  async create(
    context: TenantContext,
    membershipId: string,
    body: unknown,
  ): Promise<HomeQuickLinksView> {
    const input = parseCreateInput(body);
    return this.database.transaction(context, async (tx) => {
      const count = await this.repository.countForMembership(tx, context, membershipId);
      if (count >= MAX_QUICK_LINKS) {
        throw new ApiError(409, 'conflict', `You can keep at most ${MAX_QUICK_LINKS} quick links`);
      }
      await this.repository.insert(tx, context, {
        membershipId,
        label: input.label,
        path: input.path,
        position: count,
      });
      const rows = await this.repository.listForMembership(tx, context, membershipId);
      return project(rows);
    });
  }

  /**
   * Reorder the caller's quick links. The body's `ids` must be exactly a permutation of the caller's
   * current link ids — any unknown id, duplicate or omission is a 400 with no write (the allowlist).
   * Positions are reassigned as a dense `0..n-1` sequence in the given order. Returns the caller's
   * links after the reorder (200).
   */
  async reorder(
    context: TenantContext,
    membershipId: string,
    body: unknown,
  ): Promise<HomeQuickLinksView> {
    const ids = parseOrderInput(body);
    return this.database.transaction(context, async (tx) => {
      const rows = await this.repository.listForMembership(tx, context, membershipId);
      const existing = new Set(rows.map((row) => row.id));

      // Exactly a permutation of the caller's own ids: same size, every id known, no duplicate.
      const seen = new Set<string>();
      for (const id of ids) {
        if (!existing.has(id) || seen.has(id)) {
          throw new ApiError(
            400,
            'validation_failed',
            'The order must list each of your quick links exactly once',
            [{ field: 'ids', message: 'must be a permutation of your quick-link ids' }],
          );
        }
        seen.add(id);
      }
      if (seen.size !== existing.size) {
        throw new ApiError(
          400,
          'validation_failed',
          'The order must list each of your quick links exactly once',
          [{ field: 'ids', message: 'must be a permutation of your quick-link ids' }],
        );
      }

      for (let position = 0; position < ids.length; position += 1) {
        await this.repository.updatePosition(tx, context, membershipId, ids[position]!, position);
      }
      const reordered = await this.repository.listForMembership(tx, context, membershipId);
      return project(reordered);
    });
  }

  /**
   * Remove the caller's quick link by id. Own-membership: an id that names another member's link (or
   * no link) removes nothing and answers 404 — a quick link is private, so its existence is never
   * disclosed to a member it does not belong to. Returns the caller's links after the remove (200).
   */
  async remove(
    context: TenantContext,
    membershipId: string,
    id: string,
  ): Promise<HomeQuickLinksView> {
    const removed = await this.database.transaction(context, (tx) =>
      this.repository.deleteOwn(tx, context, membershipId, id),
    );
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.list(context, membershipId);
  }
}

/** Project rows to the wire view — position kept so the client can hold a stable order. */
function project(
  rows: readonly { id: string; label: string; path: string; position: number }[],
): HomeQuickLinksView {
  return {
    links: rows.map((row) => ({
      id: row.id,
      label: row.label,
      path: row.path,
      position: row.position,
    })),
  };
}

/**
 * Validate a create body into `{ label, path }`. The label must be a non-empty string within the
 * column width; the path must be a safe relative in-app path (see {@link isSafeInAppPath}). Any
 * failure is a single 400 and nothing is written.
 */
function parseCreateInput(body: unknown): CreateInput {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const rawLabel = value['label'];
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (typeof rawLabel !== 'string' || label.length === 0) {
    details.push({ field: 'label', message: 'must be a non-empty string' });
  } else if (label.length > MAX_LABEL_LENGTH) {
    details.push({ field: 'label', message: `must be at most ${MAX_LABEL_LENGTH} characters` });
  }

  const rawPath = value['path'];
  const path = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (typeof rawPath !== 'string' || path.length === 0) {
    details.push({ field: 'path', message: 'must be a non-empty string' });
  } else if (path.length > MAX_PATH_LENGTH) {
    details.push({ field: 'path', message: `must be at most ${MAX_PATH_LENGTH} characters` });
  } else if (!isSafeInAppPath(path)) {
    details.push({
      field: 'path',
      message: 'must be a relative in-app path beginning with "/" (no scheme or host)',
    });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The quick link is invalid', details);
  }
  return { label, path };
}

/**
 * A path is a safe in-app destination only if it is a single leading-slash, same-origin, scheme-less
 * path: it begins with `/`, is not a protocol-relative `//host`, carries no scheme (`://`), no
 * backslash (which some browsers fold to `/`), and no control characters. An absolute `http(s)://`
 * URL fails on both the leading-slash and the scheme checks — the open-redirect guard.
 */
function isSafeInAppPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.startsWith('//')) return false;
  if (path.includes('\\')) return false;
  if (path.includes('://')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) return false;
  return true;
}

/** Validate a reorder body into an array of ids. `ids` must be an array of strings, else a 400. */
function parseOrderInput(body: unknown): string[] {
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const raw = value['ids'];
  if (!Array.isArray(raw) || !raw.every((entry) => typeof entry === 'string')) {
    throw new ApiError(400, 'validation_failed', 'The order is invalid', [
      { field: 'ids', message: 'must be an array of quick-link ids' },
    ]);
  }
  return raw as string[];
}
