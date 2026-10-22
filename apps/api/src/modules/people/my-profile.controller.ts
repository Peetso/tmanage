import { Body, Controller, Get, HttpCode, Inject, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { MyProfileRepository } from './my-profile.repository.js';

/**
 * The signed-in member's own profile card (t2-b "Profile & preferences"): the name and job title
 * they may edit, and the sign-in email they may only read.
 *
 * ## Own profile only
 *
 * There is no membership id in the path: the subject is the authenticated principal's own
 * membership, resolved tenant-scoped by `(organization_id, id)`, so the request has no way to name
 * anybody else. Both routes sit behind `work.read`, the capability every other `…/me/*` preference
 * route uses — editing your own card needs no people/admin power.
 *
 * ## Why this route may write `users.display_name`
 *
 * x216 refused to write the GLOBAL `users.display_name` from an admin's org-scoped route, because one
 * studio's admin would rename a person in every other studio. Here the writer is the person: it is
 * their own account and their own name, which is exactly what the users row holds. The job title is
 * the tenant-local half and goes to `member_profiles.job_title` (0215). The email is read-only — a
 * sign-in identifier changes through the identity flow, never a profile form — and is ignored if
 * sent. Each save is audited (`member.profile_updated`) with which fields changed, never their values.
 */

/** Length ceilings, matching the columns (`users.display_name` 190, `member_profiles.job_title` 120). */
const MAX = { displayName: 190, jobTitle: 120 } as const;

/**
 * The read/write shape — the caller's name, sign-in email and job title (null when unset). Paired in
 * `e2e/contracts/api-web-shapes.ts` with the web `MyProfileView` the Profile & preferences screen reads.
 */
export interface MyProfileView {
  readonly displayName: string;
  readonly email: string;
  readonly jobTitle: string | null;
}

interface MyProfileBody {
  readonly displayName?: unknown;
  readonly jobTitle?: unknown;
}

interface MyProfileInput {
  readonly displayName: string;
  readonly jobTitle: string | null;
}

@Controller('v1/organizations/:orgSlug/me/profile')
export class MyProfileController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(MyProfileRepository) private readonly profiles: MyProfileRepository,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  /** Read the caller's own profile. A membership not in this tenant is a 404. */
  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<MyProfileView> {
    const row = await this.database.read(context, (runner) =>
      this.profiles.findOwn(runner, context, principal.membershipId),
    );
    if (row === null) throw notFound();
    return { displayName: row.displayName, email: row.email, jobTitle: row.jobTitle };
  }

  /**
   * Replace the caller's own name and job title. Validate (400, no write) before anything is touched;
   * resolve the own membership (404); write the name to the caller's own users row and the title to
   * this studio's profile row; audit; all in one transaction, so an audit failure rolls the save back.
   */
  @Put()
  @RequireCapability('work.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<MyProfileView> {
    const input = parseInput(body);
    return this.database.transaction(context, async (tx) => {
      const current = await this.profiles.findOwn(tx, context, principal.membershipId);
      if (current === null) throw notFound();

      const nameChanged = current.displayName !== input.displayName;
      const jobChanged = current.jobTitle !== input.jobTitle;
      if (nameChanged) await this.profiles.updateDisplayName(tx, current.userId, input.displayName);
      if (jobChanged)
        await this.profiles.upsertJobTitle(tx, context, current.userId, input.jobTitle);
      if (nameChanged || jobChanged) {
        await this.audit.record(tx, context, {
          action: 'member.profile_updated',
          objectId: principal.membershipId,
          result: 'allowed',
          metadata: { name_changed: nameChanged, job_changed: jobChanged },
        });
      }

      return { displayName: input.displayName, email: current.email, jobTitle: input.jobTitle };
    });
  }
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'my_profile_not_found');
}

/**
 * Validate the PUT body. `displayName` is required: a string, non-empty after trimming, at most 190
 * characters. `jobTitle` is optional: a string of at most 120 characters, or null / empty to clear.
 * Any other key (including `email`) is ignored. A bad field is a 400 listing every problem.
 */
function parseInput(body: unknown): MyProfileInput {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as MyProfileBody;

  let displayName = '';
  if (typeof value.displayName !== 'string') {
    details.push({ field: 'displayName', message: 'is required' });
  } else {
    displayName = value.displayName.trim();
    if (displayName.length === 0) details.push({ field: 'displayName', message: 'is required' });
    else if (displayName.length > MAX.displayName) {
      details.push({
        field: 'displayName',
        message: `must be at most ${MAX.displayName} characters`,
      });
    }
  }

  let jobTitle: string | null = null;
  if (value.jobTitle !== null && value.jobTitle !== undefined) {
    if (typeof value.jobTitle !== 'string') {
      details.push({ field: 'jobTitle', message: 'must be a string or null' });
    } else {
      const trimmed = value.jobTitle.trim();
      if (trimmed.length > MAX.jobTitle) {
        details.push({ field: 'jobTitle', message: `must be at most ${MAX.jobTitle} characters` });
      } else if (trimmed.length > 0) {
        jobTitle = trimmed;
      }
    }
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The profile is invalid', details);
  }
  return { displayName, jobTitle };
}
