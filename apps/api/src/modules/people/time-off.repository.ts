import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships, personTimeOff } from '../../common/database/schema.js';
import type { PersonTimeOffRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The person time-off repository — dated absences a manager files against a person (People module 14,
 * x325). It owns `person_time_off` (0193) and the tenant-scoped resolve of a person by their user id,
 * and nothing else. Every method is tenant-scoped in SQL the way every sibling repository is
 * (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC` §6):
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`; there is no overload without a context.
 * 2. **The tenant comes from the context, never a DTO.** {@link CreatePersonTimeOffInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * An entry is added (INSERT) and removed (DELETE), never edited — the withheld UPDATE grant is the
 * control. It carries NO policy: the `org.manage`/`work.read` route gates and the belt-and-braces
 * relation checks live in the service and controller.
 */

/** What the service inserts. No `organizationId` — it comes from the context. */
export interface CreatePersonTimeOffInput {
  /** The person the absence is filed against — resolved from `(tenant, :userId)`, never a body value. */
  readonly personUserId: string;
  /** Inclusive absence bounds, ISO-8601 dates (`YYYY-MM-DD`); the service enforces starts ≤ ends. */
  readonly startsOn: string;
  readonly endsOn: string;
  /** A value from the fixed `TIME_OFF_KINDS` allowlist — the service validates it. */
  readonly kind: string;
  readonly note: string | null;
  /** The acting user who filed the entry. */
  readonly createdByUserId: string;
}

/** A bounded overlap window for the range read. Both inclusive ISO-8601 dates (`YYYY-MM-DD`). */
export interface TimeOffRange {
  readonly from: string;
  readonly to: string;
}

export class PersonTimeOffRepository {
  /**
   * Resolve one membership by the user it names within this tenant. Tenant-scoped by
   * `organization_id` (the Known-trap), so a cross-tenant or unknown user id is not found — the
   * service turns `null` into a 404 that is indistinguishable from the id never existing, before any
   * authorize or write.
   */
  async resolvePersonMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<{ readonly userId: string } | null> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, userId),
          // 60-09: an AI employee has no time off; its working hours live on the AI employee.
          eq(memberships.kind, 'human'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * List a person's entries within the acting tenant, in start-date (then id) order. When `range` is
   * given, only entries that overlap the inclusive `[from, to]` window are returned — an entry
   * overlaps when `starts_on ≤ to AND ends_on ≥ from`. No listing without a context: on MySQL that
   * would return other studios' entries.
   */
  async listForPerson(
    runner: TenantQueryRunner,
    context: TenantContext,
    personUserId: string,
    range: TimeOffRange | null,
  ): Promise<PersonTimeOffRow[]> {
    const predicates = [
      eq(personTimeOff.organizationId, context.organizationId),
      eq(personTimeOff.personUserId, personUserId),
    ];
    if (range !== null) {
      // Overlap of [starts_on, ends_on] with [from, to]: starts on or before `to`, ends on or after
      // `from`. Both bounds are inclusive.
      predicates.push(lte(personTimeOff.startsOn, range.to));
      predicates.push(gte(personTimeOff.endsOn, range.from));
    }
    return tenantDrizzle(runner)
      .select()
      .from(personTimeOff)
      .where(and(...predicates))
      .orderBy(asc(personTimeOff.startsOn), asc(personTimeOff.id));
  }

  /** Fetch one entry by id within the acting tenant (used to read back an insert). */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<PersonTimeOffRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(personTimeOff)
      .where(
        and(eq(personTimeOff.organizationId, context.organizationId), eq(personTimeOff.id, id)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert an entry within the acting tenant, then read it back. `organization_id` comes from the
   * context, never `input`; the `(organization_id, person_user_id)` composite FK refuses a user of
   * another studio at the engine, the other half of the service's cross-tenant guard.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreatePersonTimeOffInput,
  ): Promise<PersonTimeOffRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(personTimeOff).values({
      id,
      organizationId: context.organizationId,
      personUserId: input.personUserId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      kind: input.kind,
      note: input.note,
      createdByUserId: input.createdByUserId,
      createdAt: new Date(),
    });
    const row = await this.findById(runner, context, id);
    if (!row) {
      // Unreachable: the insert above wrote the row this reads back within the same transaction.
      throw new Error(`person_time_off ${id} vanished immediately after insert`);
    }
    return row;
  }

  /**
   * Remove one entry, scoped to the acting tenant and the person it names. Returns whether a row was
   * removed. DELETE is idempotent at the route (a missing entry for a resolved person is still a 204),
   * but the scoped predicate here means an id belonging to another person or studio removes nothing.
   */
  async deleteForPerson(
    runner: TenantQueryRunner,
    context: TenantContext,
    personUserId: string,
    id: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(personTimeOff)
      .where(
        and(
          eq(personTimeOff.organizationId, context.organizationId),
          eq(personTimeOff.personUserId, personUserId),
          eq(personTimeOff.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
