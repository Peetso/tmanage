import { Controller, Get, Inject, Query } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PeopleDirectoryRepository } from './directory.repository.js';

/**
 * People & capacity — module 14, audit #4 (the `/people` stub replacement).
 *
 * ## Why it exists
 *
 * `/people` was the last true `PlannedInternalScreen` stub: a destination the rail draws and
 * then cannot open with anything but "not built yet". This is the read behind it — the list of
 * everyone in the organization, by name, with the one capacity fact a directory adds over the
 * D16 picker: how many projects each person is on.
 *
 * ## `work.read`, and so internal-only
 *
 * This is the same "who is in this organization" question the member picker answers, one every
 * internal role including `guest` is trusted with. `12-PERMISSION-MATRIX` §2 gives `work.read`
 * to every internal role and to no client role, so reusing it is what keeps the staff roster off
 * the client portal: a client principal is refused by the capability ceiling, not by a check
 * written here that a later edit could drop. No `people.*` capability is minted — the directory
 * is a read a member already has, not a new grant.
 *
 * ## What it is not
 *
 * No create, invite, role change or offboard — those live in `InvitationsController`, the
 * project-members controller and the offboarding path, each with its own capability and audit.
 * The offboarding write boundary sits at `/people/offboarding`, behind `member.offboard`; this
 * page is the read every member uses and asks for none of that.
 */

export interface PersonDirectoryView {
  readonly membershipId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  readonly status: string;
  readonly projectCount: number;
  /** PEO-01 grouping: the teams the member is assigned to, by name. */
  readonly teams: readonly { readonly id: string; readonly name: string }[];
  /** Open work the member owns, and how much of it is past due. */
  readonly openCommitments: number;
  readonly overdueCommitments: number;
  /** The first window the member declared in the next two weeks (no note), or none declared. */
  readonly declared: {
    readonly kind: string;
    readonly startDate: string;
    readonly endDate: string;
  } | null;
}

/** PEO-04's horizon: availability is read two weeks ahead, today included. */
const DECLARED_HORIZON_DAYS = 14;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * `users.display_name` is `VARCHAR(190)`, so nothing longer can match. The fragment is cut
 * rather than refused: a person typing a long string has not made an error a 400 should punish.
 */
const MAX_SEARCH_LENGTH = 190;

@Controller('v1/organizations/:orgSlug/people')
export class PeopleDirectoryController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PeopleDirectoryRepository) private readonly directory: PeopleDirectoryRepository,
  ) {}

  /**
   * The organization's active people, by name, each with a project count.
   *
   * An empty list is a 200 with an empty array. `membershipId` is the keyset cursor and is
   * returned as `nextAfter` when the page came back full — a caller holds it to ask for the next
   * page and does nothing else with it, so it is never projected as a person's identifier.
   *
   * `q` narrows by name on the server, which is what makes an organization larger than one page
   * usable: without it the fifty-first person is unreachable, and paging the whole roster into
   * the browser to filter it there would ship the staff list to answer a keystroke.
   */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
  ): Promise<{
    readonly people: readonly PersonDirectoryView[];
    readonly nextAfter: string | null;
  }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      throw new ApiError(400, 'validation_failed', 'limit must be a positive integer', [
        { field: 'limit', message: 'must be a positive integer' },
      ]);
    }

    const effectiveLimit = Math.min(parsedLimit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const search = (q ?? '').trim().slice(0, MAX_SEARCH_LENGTH);

    const now = new Date();
    const window = {
      now,
      fromDate: isoDate(now),
      toDate: isoDate(new Date(now.getTime() + (DECLARED_HORIZON_DAYS - 1) * 86_400_000)),
    };
    const { rows, details } = await this.database.read(context, async (db) => {
      const page = await this.directory.list(db, context, {
        ...(after ? { after } : {}),
        ...(search === '' ? {} : { q: search }),
        limit: effectiveLimit,
      });
      return { rows: page, details: await this.directory.rowDetails(db, context, page, window) };
    });

    const full = rows.length === effectiveLimit;
    const last = rows[rows.length - 1];

    return {
      people: rows.map((row) => {
        const extra = details.get(row.membershipId);
        return {
          membershipId: row.membershipId,
          userId: row.userId,
          displayName: row.displayName,
          role: row.role,
          status: row.status,
          projectCount: row.projectCount,
          teams: extra?.teams ?? [],
          openCommitments: extra?.openCommitments ?? 0,
          overdueCommitments: extra?.overdueCommitments ?? 0,
          declared: extra?.declared ?? null,
        };
      }),
      nextAfter: full && last ? last.membershipId : null,
    };
  }
}
