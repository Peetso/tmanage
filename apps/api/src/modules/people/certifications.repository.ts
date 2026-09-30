import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, personCertifications } from '../../common/database/schema.js';
import type { MembershipRow, PersonCertificationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The person-certifications repository — PEOPLE / module 14 (x326), following the `person_skills`
 * (x172) repository pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreatePersonCertificationInput}
 *    has no `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`), so a
 *    forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate. `createdBy` is the acting user, supplied by the controller.
 */
export interface CreatePersonCertificationInput {
  readonly personUserId: string;
  readonly name: string;
  readonly issuer: string;
  readonly issuedOn: string;
  readonly expiresOn: string | null;
  readonly createdBy: string;
}

export class PersonCertificationsRepository {
  /**
   * Resolve the person named by `personUserId` to their membership in the acting tenant, or null.
   *
   * This is the resolve-before-authorize primitive: a person in another tenant (or no such person)
   * resolves null here, so the controller returns a 404 before it authorizes or writes.
   */
  async findPersonMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    personUserId: string,
  ): Promise<MembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, personUserId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List a person's certifications, within the acting tenant, newest issue first.
   *
   * Both `organization_id` and `person_user_id` predicates are present. The order is
   * `issued_on DESC, id DESC`: `id` (UUIDv7, ≈ creation order) is the deterministic tiebreaker so two
   * credentials issued on the same day still have a stable, repeatable order.
   */
  async listForPerson(
    runner: TenantQueryRunner,
    context: TenantContext,
    personUserId: string,
  ): Promise<readonly PersonCertificationRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(personCertifications)
      .where(
        and(
          eq(personCertifications.organizationId, context.organizationId),
          eq(personCertifications.personUserId, personUserId),
        ),
      )
      .orderBy(desc(personCertifications.issuedOn), desc(personCertifications.id));
  }

  /** Fetch one certification, tenant- and person-scoped, or null. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    personUserId: string,
    certificationId: string,
  ): Promise<PersonCertificationRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(personCertifications)
      .where(
        and(
          eq(personCertifications.organizationId, context.organizationId),
          eq(personCertifications.personUserId, personUserId),
          eq(personCertifications.id, certificationId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Record a certification.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The composite foreign key
   * refuses a person from another tenant; the controller resolves the person first so an unknown id
   * maps to 404 rather than a foreign-key 500.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreatePersonCertificationInput,
  ): Promise<PersonCertificationRow> {
    const id = uuidv7();
    await tenantDrizzle(runner).insert(personCertifications).values({
      id,
      organizationId: context.organizationId,
      personUserId: input.personUserId,
      name: input.name,
      issuer: input.issuer,
      issuedOn: input.issuedOn,
      expiresOn: input.expiresOn,
      createdBy: input.createdBy,
      createdAt: new Date(),
    });
    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    const created = await this.findById(runner, context, input.personUserId, id);
    if (!created) throw new Error(`person_certification ${id} vanished after insert`);
    return created;
  }

  /**
   * Remove a person's certification, tenant- and person-scoped. Returns whether a row was removed, so
   * the controller can treat DELETE idempotently: a second delete of the same id removes nothing and
   * is still a 204. A certification belonging to another person or tenant is never touched.
   */
  async deleteById(
    runner: TenantQueryRunner,
    context: TenantContext,
    personUserId: string,
    certificationId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(personCertifications)
      .where(
        and(
          eq(personCertifications.organizationId, context.organizationId),
          eq(personCertifications.personUserId, personUserId),
          eq(personCertifications.id, certificationId),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
