import { and, asc, eq, gt, inArray, like, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import type { ParsedContact } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { contactSuggestions } from '../../common/database/schema.js';
import type {
  ContactSuggestionRow,
  ContactSuggestionSource,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * R16-f (54-11 Phase 0) — storage for `contact_suggestions` (0295).
 *
 * Every statement predicates on BOTH the caller's `organization_id` and `user_id`, taken from the
 * `TenantContext` and never from a request: a person's suggestions are theirs alone, and there is
 * no method that reads another user's rows or an organization-wide list.
 */

/** IN-list and VALUES batch size: well under any packet limit for 320-character emails. */
const BATCH = 500;
/** The suggest answer is short by design (the invite picker shows a handful). */
export const SUGGEST_LIMIT = 20;

/** `%`, `_` and `\` typed by the user match themselves, not a pattern. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class ContactSuggestionsRepository {
  /** Delete the caller's expired rows (lazy expiry, run on each import). Returns the count. */
  async deleteExpired(runner: TenantQueryRunner, context: TenantContext, now: Date): Promise<void> {
    await tenantDrizzle(runner)
      .delete(contactSuggestions)
      .where(
        and(
          eq(contactSuggestions.organizationId, context.organizationId),
          eq(contactSuggestions.userId, context.userId),
          lte(contactSuggestions.expiresAt, now),
        ),
      );
  }

  /** Which of `emails` the caller already has a row for. */
  async existingEmails(
    runner: TenantQueryRunner,
    context: TenantContext,
    emails: readonly string[],
  ): Promise<ReadonlySet<string>> {
    const found = new Set<string>();
    for (let i = 0; i < emails.length; i += BATCH) {
      const rows = await tenantDrizzle(runner)
        .select({ email: contactSuggestions.email })
        .from(contactSuggestions)
        .where(
          and(
            eq(contactSuggestions.organizationId, context.organizationId),
            eq(contactSuggestions.userId, context.userId),
            inArray(contactSuggestions.email, emails.slice(i, i + BATCH)),
          ),
        );
      for (const row of rows) found.add(row.email);
    }
    return found;
  }

  /**
   * Insert or refresh the caller's rows on `UNIQUE (organization_id, user_id, email)`: a re-imported
   * address takes the new name, company and source and a fresh `expires_at`.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    source: ContactSuggestionSource,
    contacts: readonly ParsedContact[],
    now: Date,
    expiresAt: Date,
  ): Promise<void> {
    for (let i = 0; i < contacts.length; i += BATCH) {
      await tenantDrizzle(runner)
        .insert(contactSuggestions)
        .values(
          contacts.slice(i, i + BATCH).map((contact) => ({
            id: uuidv7(),
            organizationId: context.organizationId,
            userId: context.userId,
            source,
            displayName: contact.displayName,
            email: contact.email,
            company: contact.company,
            createdAt: now,
            expiresAt,
          })),
        )
        .onDuplicateKeyUpdate({
          set: {
            source: sql.raw('values(`source`)'),
            displayName: sql.raw('values(`display_name`)'),
            company: sql.raw('values(`company`)'),
            expiresAt: sql.raw('values(`expires_at`)'),
          },
        });
    }
  }

  /** The caller's unexpired rows whose name or email starts with `q`, by name, at most 20. */
  async suggest(
    runner: TenantQueryRunner,
    context: TenantContext,
    q: string,
    now: Date,
  ): Promise<readonly ContactSuggestionRow[]> {
    const prefix = `${escapeLikePattern(q)}%`;
    return tenantDrizzle(runner)
      .select()
      .from(contactSuggestions)
      .where(
        and(
          eq(contactSuggestions.organizationId, context.organizationId),
          eq(contactSuggestions.userId, context.userId),
          gt(contactSuggestions.expiresAt, now),
          or(like(contactSuggestions.displayName, prefix), like(contactSuggestions.email, prefix)),
        ),
      )
      .orderBy(asc(contactSuggestions.displayName), asc(contactSuggestions.email))
      .limit(SUGGEST_LIMIT);
  }

  /** Clear the caller's whole list. */
  async clear(runner: TenantQueryRunner, context: TenantContext): Promise<void> {
    await tenantDrizzle(runner)
      .delete(contactSuggestions)
      .where(
        and(
          eq(contactSuggestions.organizationId, context.organizationId),
          eq(contactSuggestions.userId, context.userId),
        ),
      );
  }
}
