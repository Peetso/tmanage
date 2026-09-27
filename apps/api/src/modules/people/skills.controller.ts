import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PERSON_SKILLS_REPOSITORY, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { PERSON_SKILL_LEVELS } from '../../common/database/schema.js';
import type { PersonSkillLevel, PersonSkillRow } from '../../common/database/schema.js';
import { PersonSkillDuplicateError } from './skills.repository.js';
import type { PersonSkillsRepository } from './skills.repository.js';

/**
 * People member skills (module 14, x172). Three endpoints under a member: add a skill, list a
 * member's skills, and remove one. Skills exist so a member can be found for matching; this slice
 * owns the add/list/remove of the tag, not the matching read.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on each route asks the coarse `project.manage` (write) / `work.read` (read)
 * question — does this role's ceiling include the capability at all. This controller adds the
 * authoritative application decision (`25-AUTH` §3 step 2, deny-by-default) that the guard cannot:
 * an org-scoped `authorize()` (`projectId: null`) that a suspended membership fails, exactly as
 * `WorkFormsController` does.
 *
 * ## The Known-trap order (resolve before authorize)
 *
 * Every route names a member by `:membershipId` in the path, and the delete also names a
 * `:skillId`. The membership is resolved **tenant-scoped first**, so an unknown or cross-tenant
 * `membershipId` is a 404 with no write, before any authorize or mutation. The delete then resolves
 * the skill tenant-and-member-scoped before removing it (unknown → 404, no write). A skill view
 * never echoes `organizationId`.
 */

const MAX_LABEL_LENGTH = 80;

/** What a caller is allowed to see of one member skill. `organizationId` is deliberately absent. */
export interface PersonSkillView {
  readonly id: string;
  readonly membershipId: string;
  readonly label: string;
  readonly level: PersonSkillLevel;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** An explicit projection, not a serialised row: a column added later is invisible until named. */
function toView(row: PersonSkillRow): PersonSkillView {
  return {
    id: row.id,
    membershipId: row.membershipId,
    label: row.label,
    level: row.level,
    createdAt: row.createdAt.toISOString(),
  };
}

interface AddPersonSkillBody {
  readonly label?: unknown;
  readonly level?: unknown;
}

/**
 * Normalise a submitted label: trim and collapse runs of whitespace. The controller validates the
 * result is non-empty and within {@link MAX_LABEL_LENGTH}; the same normalisation makes the UNIQUE
 * `(member, label)` key mean what a reader expects ("TypeScript" is one skill, not two).
 */
function normaliseLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ');
}

function isLevel(value: unknown): value is PersonSkillLevel {
  return typeof value === 'string' && (PERSON_SKILL_LEVELS as readonly string[]).includes(value);
}

@Controller('v1/organizations/:orgSlug/people/:membershipId/skills')
export class PersonSkillsController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(PERSON_SKILLS_REPOSITORY) private readonly skills: PersonSkillsRepository,
  ) {}

  /**
   * List a member's skills, label-ascending. `work.read`, relation-gated org-scoped (`projectId:
   * null`, so every active member may read the directory's skills). The member is resolved
   * tenant-scoped first — an unknown/cross-tenant id is 404.
   */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
  ): Promise<{ readonly skills: readonly PersonSkillView[] }> {
    await this.requireMember(context, membershipId);
    if (!this.mayActOrg(principal, context, 'work.read')) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'person_skill_read_denied',
      );
    }

    const rows = await this.database.read(context, (runner) =>
      this.skills.listForMember(runner, context, membershipId),
    );
    return { skills: rows.map(toView) };
  }

  /**
   * Add a skill to a member. `project.manage`, relation-gated org-scoped. The member is resolved
   * tenant-scoped BEFORE authorize (Known-trap): an unknown/cross-tenant id is 404 with no write.
   * A bad/over-length label is 400; a duplicate `(member, label)` is 409.
   */
  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Body() body: AddPersonSkillBody,
  ): Promise<PersonSkillView> {
    await this.requireMember(context, membershipId);
    if (!this.mayActOrg(principal, context, 'project.manage')) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'person_skill_write_denied',
      );
    }

    const label = normaliseLabel(body?.label);
    const details = [
      ...(label === '' ? [{ field: 'label', message: 'must be a non-empty string' }] : []),
      ...(label.length > MAX_LABEL_LENGTH
        ? [{ field: 'label', message: `must be at most ${MAX_LABEL_LENGTH} characters` }]
        : []),
      ...(isLevel(body?.level)
        ? []
        : [{ field: 'level', message: `must be one of ${PERSON_SKILL_LEVELS.join(', ')}` }]),
    ];
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    const level = body?.level as PersonSkillLevel;

    try {
      const row = await this.database.transaction(context, (tx) =>
        this.skills.create(tx, context, { membershipId, label, level }),
      );
      return toView(row);
    } catch (error) {
      if (error instanceof PersonSkillDuplicateError) {
        throw new ApiError(409, 'conflict', error.message, undefined, 'person_skill_duplicate');
      }
      throw error;
    }
  }

  /**
   * Remove a member's skill. `project.manage`. The member and then the skill are resolved
   * tenant-scoped first: an unknown/cross-tenant member or skill id is 404 with no write.
   */
  @Delete(':skillId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('membershipId') membershipId: string,
    @Param('skillId') skillId: string,
  ): Promise<void> {
    await this.requireMember(context, membershipId);
    if (!this.mayActOrg(principal, context, 'project.manage')) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'person_skill_write_denied',
      );
    }

    const removed = await this.database.transaction(context, (tx) =>
      this.skills.deleteSkill(tx, context, membershipId, skillId),
    );
    if (!removed) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'person_skill_not_visible',
      );
    }
  }

  /**
   * Resolve the `:membershipId` tenant-scoped. Unknown / cross-tenant ⇒ 404 with no write — the
   * resolve-before-authorize Known-trap, run before any authorize or mutation on every route.
   */
  private async requireMember(context: TenantContext, membershipId: string): Promise<void> {
    if (typeof membershipId !== 'string' || membershipId === '') {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'person_skill_no_member');
    }
    const member = await this.database.read(context, (runner) =>
      this.skills.findMembership(runner, context, membershipId),
    );
    if (!member) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'person_skill_no_member');
    }
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private mayActOrg(principal: Principal, context: TenantContext, capability: Capability): boolean {
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
}
