import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MEMBERSHIPS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipsRepository } from './memberships.repository.js';

/**
 * The member directory — D16.
 *
 * ## Why it exists
 *
 * Every core work action stores a `user_id`: the owner of a work item, the person a blocker's
 * ask sits on. Until now no route told a client what those ids *were*, so the only way to
 * assign anything was to find a UUID somewhere else and paste it. The review filed that as
 * D16 and it is not a cosmetic complaint — it makes a shipped feature unusable by the
 * ordinary member it was built for. This route is the list of names that makes the id an
 * implementation detail again.
 *
 * ## `work.read`, for the reason `WorkspacesController` gives
 *
 * This is a list of names a person needs in order to *file* something, not a management
 * surface. `12-PERMISSION-MATRIX` §2 gives `work.read` to every internal role including
 * `guest`, which is the right floor for "who is in this organization" — a guest who can be
 * shown a work item can be shown who owns it.
 *
 * The same choice is what keeps the roster internal. `work.read` is held by no client role
 * (see the note above `client_admin` in `capabilities.ts`: the absence of `work.read` there
 * is load-bearing), so a client principal is refused by the capability guard rather than by a
 * check written here. A client portal must never be handed the agency's staff list, and that
 * refusal now comes from the same place every other internal read's does.
 *
 * ## What it is not
 *
 * There is no create, invite, role change or offboard route here. Those exist already —
 * `InvitationsController` and the offboarding path — with their own capabilities and their
 * own audit. And there is no per-project member list yet: the same pattern over
 * `project_memberships` is a fast follow, and adding it without a screen behind it is how an
 * API surface grows faster than anything can exercise it.
 */

export interface MemberView {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
}

const MAX_LIMIT = 200;

/**
 * Stated here and always sent, rather than left to the repository's own default, because
 * `nextAfter` below is derived from whether the page came back full. A limit the controller
 * did not choose is one it cannot compare the row count against.
 */
const DEFAULT_LIMIT = 50;

/**
 * `users.display_name` is `VARCHAR(190)`, so nothing longer than that can match anything. The
 * fragment is cut rather than refused: a caller has not made an error, and a 400 would be an
 * error path with no way for an ordinary client to reach it.
 */
const MAX_SEARCH_LENGTH = 190;

@Controller('v1/organizations/:orgSlug/members')
export class MembersController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(MEMBERSHIPS_REPOSITORY) private readonly memberships: MembershipsRepository,
  ) {}

  /**
   * The organization's active members, by name.
   *
   * Active only, and the status filter is not a query parameter. An invited person has not
   * accepted and authorises nothing; a suspended one must not be handed new work. Offering
   * them in a picker would mean assigning work to somebody who cannot receive it, so the
   * directory answers the question the picker is actually asking rather than the more general
   * one. Administration screens that need the other statuses read the membership rows.
   *
   * An empty list is a 200 with an empty array. A brand-new organization has exactly one
   * member and it is the caller; an organization with none is not an error state the client
   * can act on differently from an error.
   *
   * `membershipId` is not projected. It is the keyset cursor and it is returned as `nextAfter`
   * when the page is full, which is the only thing a caller does with it — a client that held
   * membership ids would grow a second identifier for a person with no route that takes one.
   *
   * `q` narrows by name, and it is the reason this route is usable by an organization of any
   * size. One page is 50 people; without a search, the fifty-first member of an organization is
   * somebody a picker can never offer and therefore somebody no work can be assigned to. The
   * search is here rather than in the browser because the alternative is shipping the whole
   * staff list to the client to answer a keystroke. It narrows this tenant's own query — the
   * `organization_id` predicate and the active-only filter are untouched by it — so it can
   * reach further into the roster the caller already has, and nowhere else.
   */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
  ): Promise<{ readonly members: readonly MemberView[]; readonly nextAfter: string | null }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      throw new ApiError(400, 'validation_failed', 'limit must be a positive integer', [
        { field: 'limit', message: 'must be a positive integer' },
      ]);
    }

    const effectiveLimit = Math.min(parsedLimit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const search = (q ?? '').trim().slice(0, MAX_SEARCH_LENGTH);

    const rows = await this.database.read(context, (db) =>
      this.memberships.listWithNames(db, context, {
        ...(after ? { after } : {}),
        ...(search === '' ? {} : { q: search }),
        limit: effectiveLimit,
      }),
    );

    // A full page means there may be another; a short one means there is not. The cursor is
    // the last row's membership id, which is what `listWithNames` orders and pages on.
    const full = rows.length === effectiveLimit;
    const last = rows[rows.length - 1];

    return {
      members: rows.map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        role: row.role,
        status: row.status,
      })),
      nextAfter: full && last ? last.membershipId : null,
    };
  }
}
