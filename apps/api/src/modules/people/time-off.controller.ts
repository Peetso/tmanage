import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonTimeOffRow } from '../../common/database/schema.js';
import { PersonTimeOffRepository } from './time-off.repository.js';
import type { TimeOffRange } from './time-off.repository.js';
import { PersonTimeOffService } from './time-off.service.js';
import type { PersonTimeOffBody } from './time-off.service.js';

/**
 * Person time-off (People module 14, x325). A manager files dated absences against a person for
 * capacity context — an entry is a start date, an end date, a kind (vacation/sick/other), and an
 * optional note — lists a person's entries, and removes one. Stored records only: no approval
 * workflow, no dispatch. `38-MODULE-MAP` §People & capacity (time off / PTO), `22-SCREEN` §Person
 * detail.
 *
 * ## Distinct from member availability (0096, x218)
 *
 * `member_availability` is a member managing *their own* recurring out-of-office windows behind
 * `work.read`, keyed by the acting membership. This is a *manager* filing dated absences *for another
 * person* behind `org.manage`, keyed by the person's `(organization_id, person_user_id)`.
 *
 * ## The capabilities, and resolve before authorize
 *
 * The write surface (POST/DELETE) sits behind **`org.manage`** — the existing internal-only
 * people/admin capability, reused so this slice touches neither `capabilities.ts` nor the role grid.
 * The read (GET) sits behind **`work.read`** — the internal-read capability every internal role holds
 * and no client role does, so any authenticated member can read a colleague's absences for capacity
 * context. `CapabilityGuard` refuses a principal without the route capability (a 403) before the
 * handler runs; inside, the service **resolves the target person tenant-scoped first** —
 * `(organization_id, :userId)` — and a cross-tenant or unknown id is a 404 before the belt-and-braces
 * `authorize()` guard runs, so a cross-tenant probe cannot tell "not a member here" from "not
 * allowed". The write body is validated only after resolve and authorize — a malformed field is a
 * 400 with no write.
 */

/** What a caller is allowed to see of one time-off entry. `organizationId` is deliberately absent. */
export interface PersonTimeOffView {
  readonly id: string;
  readonly personUserId: string;
  /** Inclusive absence bounds, ISO-8601 dates (`YYYY-MM-DD`). */
  readonly startsOn: string;
  readonly endsOn: string;
  /** One of {@link TIME_OFF_KINDS}. */
  readonly kind: string;
  readonly note: string | null;
  readonly createdByUserId: string;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: PersonTimeOffRow): PersonTimeOffView {
  return {
    id: row.id,
    personUserId: row.personUserId,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    kind: row.kind,
    note: row.note ?? null,
    createdByUserId: row.createdByUserId,
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

@Controller('v1/organizations/:orgSlug/people/:userId/time-off')
export class PersonTimeOffController {
  constructor(@Inject(PersonTimeOffService) private readonly service: PersonTimeOffService) {}

  /**
   * List a person's time-off entries, optionally within an inclusive `?from&to` overlap window.
   * `work.read`, resolve (404) before the org-scoped deny-by-default (403). A person with no entries
   * reads an empty list; a bounded range returns only entries overlapping `[from, to]`.
   */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ readonly entries: readonly PersonTimeOffView[] }> {
    requireId(userId, 'userId');
    const range = parseRange(from, to);
    const rows = await this.service.list(context, userId, range, () => {
      if (!mayActOrg(principal, context, 'work.read')) throw denied('time_off_read_denied');
    });
    return { entries: rows.map(toView) };
  }

  /**
   * File a time-off entry against a person. `org.manage`, resolve (404) before the org-scoped
   * deny-by-default (403), then validate (400) — a bad `kind` or `endsOn < startsOn` is a 400 with no
   * write. The acting user is recorded as `createdByUserId`.
   */
  @Post()
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Body() body: PersonTimeOffBody,
  ): Promise<PersonTimeOffView> {
    requireId(userId, 'userId');
    const row = await this.service.create(context, userId, principal.userId, body, () => {
      if (!mayActOrg(principal, context, 'org.manage')) throw denied('time_off_write_denied');
    });
    return toView(row);
  }

  /**
   * Remove one time-off entry. `org.manage`, resolve (404) before the org-scoped deny-by-default
   * (403). Idempotent: once the person resolves and the caller is allowed, a missing or already-removed
   * entry is still a 204.
   */
  @Delete(':entryId')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Param('entryId') entryId: string,
  ): Promise<void> {
    requireId(userId, 'userId');
    requireId(entryId, 'entryId');
    await this.service.remove(context, userId, entryId, () => {
      if (!mayActOrg(principal, context, 'org.manage')) throw denied('time_off_write_denied');
    });
  }
}

function denied(code: string): ApiError {
  return new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, code);
}

function requireId(value: string, field: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

// `YYYY-MM-DD`, the shape the range bounds take.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the optional `?from&to` overlap window. Both-or-neither: neither present is an unbounded list
 * (`null`); both present and well-formed with `from ≤ to` is the window; anything else — one without
 * the other, a malformed date, or `from` after `to` — is a 400 with no read.
 */
function parseRange(from: string | undefined, to: string | undefined): TimeOffRange | null {
  const hasFrom = from !== undefined && from !== '';
  const hasTo = to !== undefined && to !== '';
  if (!hasFrom && !hasTo) return null;

  const details: { field: string; message: string }[] = [];
  if (!hasFrom) details.push({ field: 'from', message: 'both from and to are required together' });
  if (!hasTo) details.push({ field: 'to', message: 'both from and to are required together' });
  if (hasFrom && !ISO_DATE.test(from as string)) {
    details.push({ field: 'from', message: 'must be an ISO-8601 date (YYYY-MM-DD)' });
  }
  if (hasTo && !ISO_DATE.test(to as string)) {
    details.push({ field: 'to', message: 'must be an ISO-8601 date (YYYY-MM-DD)' });
  }
  if (
    details.length === 0 &&
    hasFrom &&
    hasTo &&
    Date.parse(from as string) > Date.parse(to as string)
  ) {
    details.push({ field: 'to', message: 'must be on or after from' });
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The time-off range is invalid', details);
  }
  return { from: from as string, to: to as string };
}

/**
 * x325's wiring — a self-contained module registered from `app.module.ts`, kept file-disjoint from
 * the other People slices. The controller injects the `@Global` `TENANT_DATABASE`, from which it
 * constructs the stateless service over its repository; both are created in the factory so the module
 * owns no shared token.
 */
@Module({})
export class PersonTimeOffModule {
  static register(): DynamicModule {
    return {
      module: PersonTimeOffModule,
      providers: [
        {
          provide: PersonTimeOffService,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) =>
            new PersonTimeOffService(database, new PersonTimeOffRepository()),
        },
      ],
      controllers: [PersonTimeOffController],
    };
  }
}
