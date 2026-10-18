import { Body, Controller, Get, HttpCode, Inject, Module, Param, Put } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MemberProfileRepository } from './member-profile.repository.js';
import type { MemberProfileInput } from './member-profile.repository.js';

/**
 * x216's HTTP surface — a member's tenant-local editable profile (module 14 People & capacity;
 * re-scope of BLOCKED x192). x168 built the People directory and x169 the read-only per-member
 * profile, both pure reads. There was NO writable person store: the only editable name field,
 * `users.display_name`, is GLOBAL (the users table carries no `organization_id`), so an org-scoped
 * route that wrote it would change how the same person appears in every studio they belong to — the
 * cross-tenant leak that blocked x192.
 *
 * This slice adds the missing tenant-scoped store: `department`, `bio`, `contact_email` and
 * `contact_phone`, one row per member per studio (`member_profiles`, 0094), edited only here. The
 * route **never** touches `users.display_name` or any other global identity column.
 *
 * ## Capability, and resolve before authorize
 *
 * Both routes are behind **`org.manage`** — the existing people/admin capability (owner-only,
 * internal-only in `capabilities.ts`), reused so this slice touches neither `capabilities.ts` nor
 * the role grid. `CapabilityGuard` refuses a principal without it (a 403) before either handler
 * runs. Inside, the membership is **resolved tenant-scoped first** — `(organization_id,
 * :membershipId)` — and a cross-tenant or unknown id is a 404, indistinguishable from the id never
 * existing (the FAST-PROTOCOL Known-trap). Only then does the belt-and-braces `authorize()` run: the
 * org-level relation half of the route's `org.manage` ceiling, so a client (the capability is
 * internal-only) or a member who does not hold it is refused with a 403 here, rather than a profile
 * being read or written. On PUT the body is validated after resolve — a malformed field is a 400
 * with no write, never a truncated or half-valid row stored.
 */

/** One project field length ceiling, applied before any write; an oversize value is a 400. */
const MAX = { department: 120, bio: 2000, contactEmail: 320, contactPhone: 40 } as const;

// A pragmatic email shape: one `@`, a dot in the domain, no spaces. The stored value is contact
// metadata, not an identity — the strict identity check lives on the users table, not here.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Digits and the common separators a phone number carries. Kept deliberately loose (no locale
// parsing), but closed enough that free prose is rejected rather than stored as a "phone".
const PHONE = /^[+()\-.\s0-9]{3,40}$/;

/**
 * x216's read/write shape — one member's tenant-local profile. `membershipId` identifies the member
 * within this studio; the four fields are the editable metadata, each null when unset. No global
 * identity field (no `displayName`, no `email` from the users row) is projected here. Paired in
 * `e2e/contracts/api-web-shapes.ts` with the web shape the edit screen consumes (CONTRACT-001).
 */
export interface MemberProfileView {
  readonly membershipId: string;
  readonly department: string | null;
  readonly bio: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
}

/** The PUT body — every field arrives as `unknown` and is validated in the route. */
interface MemberProfileBody {
  readonly department?: unknown;
  readonly bio?: unknown;
  readonly contactEmail?: unknown;
  readonly contactPhone?: unknown;
}

@Controller('v1/organizations/:orgSlug/people/:membershipId/profile')
export class MemberProfileController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(MemberProfileRepository) private readonly profiles: MemberProfileRepository,
  ) {}

  /**
   * Read a member's tenant-local profile. Tenant-scoped by `orgSlug`; the membership is resolved
   * tenant-scoped **before** authorize (a cross-tenant/unknown id is a 404), then a caller without
   * `org.manage`'s relation is a 403. A member with no saved profile reads every field as null.
   */
  @Get()
  @RequireCapability('org.manage')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<MemberProfileView> {
    const resolved = await this.database.read(context, async (runner) => {
      const member = await this.profiles.resolveMember(runner, context, membershipId);
      if (member === null) return null;
      const fields = await this.profiles.findProfile(runner, context, member.userId);
      return { member, fields };
    });

    if (resolved === null) throw notFound();
    if (!this.mayManagePeople(principal, context)) throw denied();

    return { membershipId: resolved.member.membershipId, ...resolved.fields };
  }

  /**
   * Create or replace a member's tenant-local profile. Resolve (404) before authorize (403), then
   * validate (400) before the upsert — a malformed body writes nothing. **Never writes
   * `users.display_name`**: this route touches only `member_profiles`.
   */
  @Put()
  @RequireCapability('org.manage')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body() body: unknown,
  ): Promise<MemberProfileView> {
    const fields = await this.database.transaction(context, async (tx) => {
      // Resolve first (Known-trap): a cross-tenant/unknown id is not found in this tenant.
      const member = await this.profiles.resolveMember(tx, context, membershipId);
      if (member === null) throw notFound();
      // Belt-and-braces org-level relation check, mirroring the route's `org.manage` ceiling.
      if (!this.mayManagePeople(principal, context)) throw denied();
      // Validate only once existence and permission are established; a bad field is a 400, no write.
      const input = parseInput(body);
      await this.profiles.upsertProfile(tx, context, member.userId, input);
      return input;
    });

    return { membershipId, ...fields };
  }

  /**
   * Whether this principal may manage the org's people, judged by `org.manage` against the
   * organization itself (`projectId: null`, internal audience) — the org-level relation half of the
   * capability the route gated on the role. An internal role that holds `org.manage` is allowed; a
   * client is refused because `org.manage` is internal-only, and a cross-tenant principal by the
   * tenant check inside `authorize`.
   */
  private mayManagePeople(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'member_profile_not_found');
}

function denied(): ApiError {
  return new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'member_profile_denied');
}

/**
 * Validate and normalise the PUT body into the four tenant-local fields. Every field is optional and
 * NULLable; a missing field is treated as cleared (`null`), since PUT is a full replacement and the
 * edit form sends the whole set. A present non-string value, an oversize value, or a malformed email
 * or phone is a 400 — the client's error, never a truncated or half-valid row stored.
 */
function parseInput(body: unknown): MemberProfileInput {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as MemberProfileBody;

  const text = (field: keyof typeof MAX): string | null => {
    const raw = value[field];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string') {
      details.push({ field, message: 'must be a string or null' });
      return null;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > MAX[field]) {
      details.push({ field, message: `must be at most ${MAX[field]} characters` });
      return null;
    }
    return trimmed;
  };

  const department = text('department');
  const bio = text('bio');
  const contactEmail = text('contactEmail');
  const contactPhone = text('contactPhone');

  if (contactEmail !== null && !EMAIL.test(contactEmail)) {
    details.push({ field: 'contactEmail', message: 'must be a valid email address, or null' });
  }
  if (contactPhone !== null && !PHONE.test(contactPhone)) {
    details.push({ field: 'contactPhone', message: 'must be a valid phone number, or null' });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The profile is invalid', details);
  }

  return { department, bio, contactEmail, contactPhone };
}

/**
 * x216's wiring — a self-contained module registered from `app.module.ts`, kept file-disjoint from
 * x168's directory and x169's read-only profile module. The service is a stateless collection of
 * tenant-scoped reads and one upsert; the controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class MemberProfileModule {
  static register(): DynamicModule {
    return {
      module: MemberProfileModule,
      providers: [
        { provide: MemberProfileRepository, useFactory: () => new MemberProfileRepository() },
      ],
      controllers: [MemberProfileController],
    };
  }
}
