import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, personSkills } from '../../common/database/schema.js';
import type {
  MembershipRow,
  PersonSkillLevel,
  PersonSkillRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The person-skills repository — People member skills (module 14, x172), following the
 * `work-forms` / `document_templates` tenant-scoped pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreatePersonSkillInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * Membership resolution lives here too ({@link findMembership}) so the controller can resolve the
 * `:membershipId` path parameter tenant-scoped *before* it authorizes — a cross-tenant or unknown
 * member is a 404 with no write, the Known-trap this slice guards.
 */

/** MySQL's duplicate-key error number, raised by the UNIQUE (org, membership, label) key. */
const ER_DUP_ENTRY = 1062;

/**
 * A duplicate-key violation, seen through whatever wraps it. The `mysql2` driver raises
 * `{ errno: 1062, code: 'ER_DUP_ENTRY' }`, but Drizzle re-throws it wrapped, carrying the original
 * on `.cause`, so the marker can be one level down.
 */
function isDuplicateKeyError(error: unknown): boolean {
  const marks = (candidate: unknown): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === ER_DUP_ENTRY ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  if (marks(error)) return true;
  return typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause);
}

/** A member already declares this label. The controller maps this to 409. */
export class PersonSkillDuplicateError extends Error {
  constructor(readonly label: string) {
    // No organization id in the message: a conflict must not let a probe read across tenants.
    super(`A skill with that label already exists for this member`);
    this.name = 'PersonSkillDuplicateError';
  }
}

/**
 * What the controller creates. No `organizationId` (from the context), so a request body cannot
 * choose the tenant it writes into. `membershipId` is the resolved, tenant-scoped path parameter.
 */
export interface CreatePersonSkillInput {
  readonly membershipId: string;
  readonly label: string;
  readonly level: PersonSkillLevel;
}

export class PersonSkillsRepository {
  /**
   * Resolve a membership by id, within the acting tenant.
   *
   * No `findMembership(id)` without a context: on MySQL that would return another customer's row.
   * A cross-tenant or unknown id resolves to null here, which the controller turns into a 404
   * before authorizing or writing — the resolve-before-authorize Known-trap.
   */
  async findMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<MembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.id, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List a member's skills, label-ascending then id, within the acting tenant. Both the tenant
   * predicate and the member predicate are present, with a deterministic order.
   */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly PersonSkillRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(personSkills)
      .where(
        and(
          eq(personSkills.organizationId, context.organizationId),
          eq(personSkills.membershipId, membershipId),
        ),
      )
      .orderBy(asc(personSkills.label), asc(personSkills.id));
  }

  /** Fetch one skill by id, scoped to the acting tenant and the owning member. */
  async findSkill(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    skillId: string,
  ): Promise<PersonSkillRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(personSkills)
      .where(
        and(
          eq(personSkills.organizationId, context.organizationId),
          eq(personSkills.membershipId, membershipId),
          eq(personSkills.id, skillId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Add a skill to a member. The id is generated here (UUIDv7). `organization_id` comes from the
   * context, never from `input`. A duplicate `(membership, label)` is refused at the engine by the
   * UNIQUE key and translated to {@link PersonSkillDuplicateError}, the same rule in the application
   * as at the engine, so a concurrent double-add cannot both win.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreatePersonSkillInput,
  ): Promise<PersonSkillRow> {
    const id = uuidv7();
    try {
      await tenantDrizzle(runner).insert(personSkills).values({
        id,
        organizationId: context.organizationId,
        membershipId: input.membershipId,
        label: input.label,
        level: input.level,
        createdAt: new Date(),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new PersonSkillDuplicateError(input.label);
      throw error;
    }
    const created = await this.findSkill(runner, context, input.membershipId, id);
    if (!created) throw new Error(`person_skill ${id} vanished after insert`);
    return created;
  }

  /**
   * Remove a skill, scoped to the acting tenant and the owning member. Returns whether a row was
   * removed, so the controller can 404 an unknown/cross-tenant id with no write having happened.
   */
  async deleteSkill(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    skillId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(personSkills)
      .where(
        and(
          eq(personSkills.organizationId, context.organizationId),
          eq(personSkills.membershipId, membershipId),
          eq(personSkills.id, skillId),
        ),
      );

    return result[0].affectedRows > 0;
  }
}
