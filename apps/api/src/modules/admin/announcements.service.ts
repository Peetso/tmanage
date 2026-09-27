import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { OrgAnnouncementRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { OrgAnnouncementsRepository } from './announcements.repository.js';

/**
 * Org-wide admin announcement banners (Administration module 18, x276). An org admin posts a banner
 * (title, body, optional active window), any member reads the banners active right now, and an admin
 * deletes one. Per-member dismissal is remembered in the browser this slice, so there is no second
 * table. A self-contained module and store, file-disjoint from the other administration slices.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse question a guard can answer with no object loaded — `org.manage` for
 * the post and delete, `work.read` for the read. This service adds the org-level relation decision with
 * the real `authorize`:
 *
 * - **Post / delete** authorize `org.manage` org-wide (`projectId: null`, internal audience) — the same
 *   org-administration capability the audit viewer, members admin and settings sit behind. A caller the
 *   check refuses is a 403 with no write; `org.manage` is internal-only, so a client is refused exactly
 *   as the route's guard refuses one.
 * - **Delete resolves the announcement tenant-scoped BEFORE it authorizes** (the Known-trap order): a
 *   missing id, or one belonging to another tenant, is a 404 with no delete — decided before the
 *   `org.manage` authorize — so a cross-tenant id is indistinguishable from an unknown one and never
 *   leaks its existence. A delete of an announcement that exists is idempotent (204) whether or not a
 *   row was removed.
 *
 * The read is authorized by the route's `work.read` (an authenticated member of the org) and scoped to
 * the caller's organization in SQL, then filtered to the active-now window in the service — so it never
 * returns another tenant's banners and never returns one outside its window.
 */

/**
 * What a member sees of one active announcement — the wire projection. `organizationId` and `createdBy`
 * are deliberately absent: `25-AUTH` §7 never echoes the tenant id, and the posting membership is an
 * internal identifier a banner reader has no need of.
 */
export interface AnnouncementView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** ISO-8601 instant, or null for an open bound. */
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

/** What the controller passes to {@link OrgAnnouncementsService.create} after parsing the body. */
export interface CreateAnnouncementCommand {
  readonly title: string;
  readonly body: string;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}

const TITLE_MAX = 200;
const BODY_MAX = 20_000;

export class OrgAnnouncementsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly announcements: OrgAnnouncementsRepository = new OrgAnnouncementsRepository(),
  ) {}

  /**
   * Post an announcement for the org (200 — the created banner). The caller's `org.manage` is authorized
   * for real first (403 no insert); the title must be a non-empty trimmed string within bounds and the
   * body within bounds (400 no insert); a supplied `endsAt` must be strictly after a supplied `startsAt`
   * (400 no insert). Only then is the row inserted.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    command: CreateAnnouncementCommand,
  ): Promise<AnnouncementView> {
    this.requireOrgManage(principal, context);

    const title = typeof command.title === 'string' ? command.title.trim() : '';
    if (title.length === 0) {
      throw new ApiError(400, 'validation_failed', 'An announcement title is required.', [
        { field: 'title', message: 'Enter a title for the announcement.' },
      ]);
    }
    if (title.length > TITLE_MAX) {
      throw new ApiError(400, 'validation_failed', 'That announcement title is too long.', [
        { field: 'title', message: `Keep the title to ${TITLE_MAX} characters or fewer.` },
      ]);
    }

    const body = typeof command.body === 'string' ? command.body : '';
    if (body.length > BODY_MAX) {
      throw new ApiError(400, 'validation_failed', 'That announcement body is too long.', [
        { field: 'body', message: `Keep the body to ${BODY_MAX} characters or fewer.` },
      ]);
    }

    const startsAt = parseInstant(command.startsAt, 'startsAt');
    const endsAt = parseInstant(command.endsAt, 'endsAt');
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new ApiError(400, 'validation_failed', 'The end must be after the start.', [
        { field: 'endsAt', message: 'Choose an end time after the start time.' },
      ]);
    }

    const row = await this.database.transaction(context, (tx) =>
      this.announcements.create(tx, context, {
        title,
        body,
        startsAt,
        endsAt,
        createdBy: context.membershipId,
      }),
    );
    return toView(row);
  }

  /**
   * Delete an announcement (idempotent, 204). The announcement is resolved tenant-scoped FIRST: a
   * missing or cross-tenant id is a 404 with no delete, decided before the `org.manage` authorize (the
   * Known-trap order). A resolved announcement the caller may manage is removed; a repeated delete of an
   * already-gone id is still 404 — the resource no longer exists.
   */
  async remove(context: TenantContext, principal: Principal, id: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const existing = await this.announcements.findById(tx, context, id);
      if (!existing) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'announcement_not_found',
        );
      }
      this.requireOrgManage(principal, context);
      await this.announcements.remove(tx, context, id);
    });
  }

  /**
   * List the caller's organization's announcements that are active right now — the window
   * `[startsAt, endsAt]` contains the current instant, with a null bound treated as open. Scoped to the
   * caller's organization in SQL; the window filter is applied here against a single `now`.
   */
  async listActive(context: TenantContext): Promise<readonly AnnouncementView[]> {
    const now = Date.now();
    const rows = await this.database.read(context, (runner) =>
      this.announcements.listForOrg(runner, context),
    );
    return rows.filter((row) => isActiveNow(row, now)).map(toView);
  }

  /**
   * The real org-wide `org.manage` decision (the decorator is the coarse HTTP gate). A denial is a 403
   * with the machine-readable code. Internal-only, so a client is refused here.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `org_announcements.manage:${verdict.code}`,
      );
    }
  }
}

/** Whether an announcement's window contains `now` (ms). A null bound is open on that side. */
function isActiveNow(row: OrgAnnouncementRow, now: number): boolean {
  if (row.startsAt && row.startsAt.getTime() > now) return false;
  if (row.endsAt && row.endsAt.getTime() <= now) return false;
  return true;
}

/**
 * Parse an optional ISO-8601 instant. `null`/`undefined`/`''` is an open bound (null); a non-string or
 * unparseable value is a 400 with no write.
 */
function parseInstant(value: string | null, field: string): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'validation_failed', 'That is not a valid time.', [
      { field, message: 'Provide an ISO-8601 time or leave it empty.' },
    ]);
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new ApiError(400, 'validation_failed', 'That is not a valid time.', [
      { field, message: 'Provide an ISO-8601 time or leave it empty.' },
    ]);
  }
  return at;
}

/** Project a stored row to the wire shape (tenant id and author membership never echoed). */
function toView(row: OrgAnnouncementRow): AnnouncementView {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
