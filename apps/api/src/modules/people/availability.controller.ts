import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  MEMBER_AVAILABILITY_REPOSITORY,
  MEMBERSHIPS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MemberAvailabilityRow } from '../../common/database/schema.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { MemberAvailabilityRepository } from './availability.repository.js';

/**
 * Member availability / out-of-office windows (People module 14, x218). A member manages their own
 * dated OOO windows, and the team reads a member's windows.
 *
 * ## Distinct from the sibling people slices
 *
 * x170 weekly capacity is one figure (hours per week); x215 quiet-hours is a per-day time-of-day
 * window. This is a dated *out-of-office* window — a member is away between two calendar dates — and,
 * unlike either, it is a **list**: a member has zero or more windows.
 *
 * ## The capability, and the two surfaces
 *
 * Both surfaces sit behind **`work.read`** — the internal-read capability the sibling people and
 * preferences slices reuse (`12-PERMISSION-MATRIX` names no availability capability, `work.read` is
 * the one every internal role holds and no client role does, and pass-22 forbids editing
 * `capabilities.ts`). The write surface is *owner-scoped*: the subject of POST/GET/DELETE
 * `.../people/availability` is the authenticated `principal`'s membership, never a path or body value,
 * so a caller reads, adds, and removes only their own windows. The team surface, GET
 * `.../people/:membershipId/availability`, resolves `:membershipId` **tenant-scoped first** so an
 * unknown or cross-tenant member is a 404 with no read — a cross-tenant probe cannot tell "not
 * allowed" from "does not exist".
 *
 * ## Validation
 *
 * `kind` must be one of the fixed {@link AVAILABILITY_KINDS} allowlist; `startDate`/`endDate` are
 * `YYYY-MM-DD`; `startDate ≤ endDate` — compared with bound `Date` values, never the database clock
 * (the admin-pool-clock trap). Any failure is a 400 with no write. A view never echoes
 * `organization_id`.
 */

/** What a caller is allowed to see of one OOO window. `organizationId` is deliberately absent. */
export interface AvailabilityView {
  readonly id: string;
  readonly membershipId: string;
  /** Inclusive window bounds, ISO-8601 dates (`YYYY-MM-DD`). */
  readonly startDate: string;
  readonly endDate: string;
  /** One of {@link AVAILABILITY_KINDS}. */
  readonly kind: string;
  readonly note: string | null;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** The fixed vocabulary a window's `kind` may take — an unknown value is a 400 with no write. */
export const AVAILABILITY_KINDS = ['vacation', 'sick', 'holiday', 'personal', 'other'] as const;

const MAX_NOTE_LENGTH = 500;
// `YYYY-MM-DD`, the shape the DATE columns store.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface CreateAvailabilityBody {
  readonly startDate?: unknown;
  readonly endDate?: unknown;
  readonly kind?: unknown;
  readonly note?: unknown;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: MemberAvailabilityRow): AvailabilityView {
  return {
    id: row.id,
    membershipId: row.memberId,
    startDate: row.startDate,
    endDate: row.endDate,
    kind: row.kind,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
function mayActOrg(principal: Principal, context: TenantContext, capability: Capability): boolean {
  return authorize({
    principal,
    capability,
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  }).allowed;
}

/**
 * The caller's own OOO windows: add, list, remove. The subject is always `principal.membershipId`;
 * there is no path or body that could name another member's windows.
 */
@Controller('v1/organizations/:orgSlug/people/availability')
export class PersonAvailabilityController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(MEMBER_AVAILABILITY_REPOSITORY)
    private readonly availability: MemberAvailabilityRepository,
  ) {}

  /** List the caller's own windows. `work.read`, org-scoped deny-by-default. */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly windows: readonly AvailabilityView[] }> {
    if (!mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'availability_read_denied',
      );
    }
    const rows = await this.database.read(context, (runner) =>
      this.availability.listForMember(runner, context, principal.membershipId),
    );
    return { windows: rows.map(toView) };
  }

  /**
   * Add a window to the caller's own availability. `work.read`, org-scoped deny-by-default. `kind`
   * must be allowlisted and `startDate ≤ endDate` (bound dates); otherwise 400 with no write.
   */
  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: CreateAvailabilityBody,
  ): Promise<AvailabilityView> {
    if (!mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'availability_write_denied',
      );
    }
    const input = this.parseBody(body, principal.membershipId);
    const row = await this.database.transaction(context, (tx) =>
      this.availability.create(tx, context, input),
    );
    return toView(row);
  }

  /**
   * Remove one of the caller's own windows. `work.read`, org-scoped deny-by-default. The delete is
   * scoped to the caller's membership, so an id that is unknown, cross-tenant, or another member's is
   * a 404 with no write.
   */
  @Delete(':availabilityId')
  @RequireCapability('work.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('availabilityId') availabilityId: string,
  ): Promise<void> {
    if (!mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'availability_write_denied',
      );
    }
    requireId(availabilityId, 'availabilityId');
    const removed = await this.database.transaction(context, (tx) =>
      this.availability.deleteOwn(tx, context, principal.membershipId, availabilityId),
    );
    if (!removed) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'availability_not_visible',
      );
    }
  }

  /** Validate and normalise a create body against the acting principal's membership. */
  private parseBody(body: CreateAvailabilityBody, memberId: string) {
    const details: { field: string; message: string }[] = [];

    const startDate = this.validDate(body?.startDate, 'startDate', details);
    const endDate = this.validDate(body?.endDate, 'endDate', details);

    const kind = body?.kind;
    if (typeof kind !== 'string' || !(AVAILABILITY_KINDS as readonly string[]).includes(kind)) {
      details.push({ field: 'kind', message: `must be one of ${AVAILABILITY_KINDS.join(', ')}` });
    }

    let note: string | null = null;
    if (body?.note !== undefined && body?.note !== null) {
      if (typeof body.note !== 'string') {
        details.push({ field: 'note', message: 'must be a string' });
      } else if (body.note.length > MAX_NOTE_LENGTH) {
        details.push({ field: 'note', message: `must be at most ${MAX_NOTE_LENGTH} characters` });
      } else {
        const trimmed = body.note.trim();
        note = trimmed === '' ? null : trimmed;
      }
    }

    // Compare with bound Date values, never the admin-pool clock: start must not be after end.
    if (
      startDate !== undefined &&
      endDate !== undefined &&
      Date.parse(startDate) > Date.parse(endDate)
    ) {
      details.push({ field: 'endDate', message: 'must be on or after startDate' });
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The availability window is invalid', details);
    }

    return {
      memberId,
      startDate: startDate as string,
      endDate: endDate as string,
      kind: kind as string,
      note,
    };
  }

  private validDate(
    value: unknown,
    field: string,
    details: { field: string; message: string }[],
  ): string | undefined {
    if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
      details.push({ field, message: 'must be an ISO-8601 date (YYYY-MM-DD)' });
      return undefined;
    }
    return value;
  }
}

/**
 * The team view: read one member's OOO windows. `:membershipId` is resolved tenant-scoped first, so an
 * unknown or cross-tenant member is a 404 before any read.
 */
@Controller('v1/organizations/:orgSlug/people/:membershipId/availability')
export class MemberAvailabilityController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(MEMBER_AVAILABILITY_REPOSITORY)
    private readonly availability: MemberAvailabilityRepository,
    @Inject(MEMBERSHIPS_REPOSITORY) private readonly memberships: MembershipsRepository,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<{ readonly windows: readonly AvailabilityView[] }> {
    requireId(membershipId, 'membershipId');

    const rows = await this.database.read(context, async (runner) => {
      // Known-trap: resolve the member tenant-scoped first. Unknown / cross-tenant ⇒ 404.
      const member = await this.memberships.findById(runner, context, membershipId);
      if (!member) return undefined;
      return this.availability.listForMember(runner, context, membershipId);
    });

    if (rows === undefined) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'member_not_visible');
    }
    if (!mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'availability_read_denied',
      );
    }
    return { windows: rows.map(toView) };
  }
}

function requireId(value: string, field: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}
