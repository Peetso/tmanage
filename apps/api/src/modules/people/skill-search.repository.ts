import { and, asc, eq, inArray } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { PERSON_SKILL_LEVELS, memberships, personSkills } from '../../common/database/schema.js';
import type { MembershipRow, PersonSkillLevel } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The skill-directory-search repository (module 14, x194). Read-only: given one or more skill
 * labels (and an optional minimum level), it finds the tenant's members who declare a matching
 * skill, following the `work-forms` / `person-skills` tenant-scoped pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read.** The only method takes the `TenantQueryRunner` and `TenantContext`; there
 *    is no overload without a context.
 * 2. **The tenant comes from the context, never the query.** The `skill`/`level` inputs are values
 *    to filter on, never a tenant selector.
 * 3. **The tenant predicate is on every statement.** Both the `person_skills` row and the joined
 *    `memberships` row carry an `organization_id = context` predicate, executed through the guard
 *    (`drizzle.ts`), so a member from another tenant can never appear in a result.
 *
 * The row count is bounded by the caller: the controller passes `limit` (a capped page size) and
 * this fetches at most `limit × labels.length` rows — the exact ceiling, since a member can match
 * each requested label at most once (the `(org, membership, label)` UNIQUE key). The controller then
 * groups by member and caps the member count; there is no unbounded scan.
 */

/** basic < proficient < expert. A minimum-level filter keeps this rung and every rung above it. */
const LEVEL_RANK: Readonly<Record<PersonSkillLevel, number>> = {
  basic: 0,
  proficient: 1,
  expert: 2,
};

/** The levels that satisfy a minimum: `min` and everything ranked at or above it. */
function levelsAtLeast(min: PersonSkillLevel): readonly PersonSkillLevel[] {
  return PERSON_SKILL_LEVELS.filter((level) => LEVEL_RANK[level] >= LEVEL_RANK[min]);
}

/** What the controller asks for. All fields are already validated/normalised by the controller. */
export interface SkillSearchQuery {
  /** Normalised, non-empty, de-duplicated skill labels to match (at least one). */
  readonly labels: readonly string[];
  /** A minimum proficiency, or null for any level. */
  readonly minLevel: PersonSkillLevel | null;
  /** The capped member page size — the ceiling on distinct members the controller will keep. */
  readonly limit: number;
}

/** One matched (member, skill) row, tenant-scoped. Grouped by the controller into a directory row. */
export interface SkillSearchMatchRow {
  readonly membershipId: string;
  readonly role: string;
  readonly status: MembershipRow['status'];
  readonly label: string;
  readonly level: PersonSkillLevel;
}

export class PersonSkillSearchRepository {
  /**
   * Find the tenant's members who declare one of `labels` (at the minimum level, if given), as
   * flat (member, skill) rows ordered by member then label. Tenant-scoped on both the skill row and
   * the joined membership; bounded to `limit × labels.length` rows.
   */
  async searchMembersBySkill(
    runner: TenantQueryRunner,
    context: TenantContext,
    query: SkillSearchQuery,
  ): Promise<readonly SkillSearchMatchRow[]> {
    const levels = query.minLevel ? levelsAtLeast(query.minLevel) : PERSON_SKILL_LEVELS;
    return tenantDrizzle(runner)
      .select({
        membershipId: personSkills.membershipId,
        role: memberships.role,
        status: memberships.status,
        label: personSkills.label,
        level: personSkills.level,
      })
      .from(personSkills)
      .innerJoin(
        memberships,
        and(
          eq(memberships.organizationId, personSkills.organizationId),
          eq(memberships.id, personSkills.membershipId),
        ),
      )
      .where(
        and(
          eq(personSkills.organizationId, context.organizationId),
          inArray(personSkills.label, [...query.labels]),
          inArray(personSkills.level, [...levels]),
        ),
      )
      .orderBy(asc(personSkills.membershipId), asc(personSkills.label))
      .limit(query.limit * query.labels.length);
  }
}
