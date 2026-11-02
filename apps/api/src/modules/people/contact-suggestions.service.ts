import { CONTACT_IMPORT_MAX_BYTES, parseContactsCsv, parseVcard } from '@tmanage/domain';
import type { ContactSkipReasons } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  ContactSuggestionRow,
  ContactSuggestionSource,
} from '../../common/database/schema.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import type { ContactSuggestionsRepository } from './contact-suggestions.repository.js';

/**
 * 54-11 Phase 0 (R16-f) — the caller's own invite suggestions, imported from a contacts file.
 *
 * The controller decides who may call (an internal member holding `people.invite` or
 * `client_member.manage`); this service owns the rest, always on the caller's own rows:
 *
 * - **import** — size cap (2 MB of UTF-8 → 413), a per-user budget of 10 imports an hour (429),
 *   the pure domain parser, then one transaction: delete the caller's expired rows, upsert the
 *   parsed contacts on `(org, user, email)` with `expires_at = now + 90 days`, and audit the
 *   counts and the source — never an address.
 * - **suggest** — prefix match on name or email over the caller's unexpired rows, at most 20.
 * - **clear** — delete the caller's whole list.
 *
 * Expiry is lazy: nothing sweeps these rows; suggest never reads an expired one and the next
 * import deletes them.
 */

export const CONTACT_SUGGESTION_TTL_DAYS = 90;
export const IMPORTS_PER_HOUR = 10;
export const SUGGEST_QUERY_MAX = 100;
const HOUR_MS = 60 * 60 * 1000;
/** The in-memory budget forgets the oldest users beyond this many (bounded memory). */
const BUDGET_USERS_MAX = 10_000;

export interface ImportContactsBody {
  readonly format?: unknown;
  readonly text?: unknown;
}

export interface ContactImportView {
  readonly imported: number;
  readonly updated: number;
  readonly skipped: number;
  readonly reasons: ContactSkipReasons;
}

/** What the picker sees of one suggestion. No ids, no tenant, no owner. */
export interface ContactSuggestionView {
  readonly displayName: string | null;
  readonly email: string;
  readonly company: string | null;
}

export interface ContactSuggestionsDeps {
  readonly audit?: Pick<AuditEventsRepository, 'append'>;
  readonly now?: () => Date;
}

export function toSuggestionView(row: ContactSuggestionRow): ContactSuggestionView {
  return { displayName: row.displayName, email: row.email, company: row.company };
}

export class ContactSuggestionsService {
  private readonly audit: Pick<AuditEventsRepository, 'append'>;
  private readonly now: () => Date;
  /** `org:user` → import instants within the last hour. One Node process serves the API. */
  private readonly budget = new Map<string, number[]>();

  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: ContactSuggestionsRepository,
    deps: ContactSuggestionsDeps = {},
  ) {
    this.audit = deps.audit ?? new AuditEventsRepository();
    this.now = deps.now ?? (() => new Date());
  }

  async importFile(context: TenantContext, body: ImportContactsBody): Promise<ContactImportView> {
    const format = body?.format;
    const text = body?.text;
    const details: { field: string; message: string }[] = [];
    if (format !== 'csv' && format !== 'vcard') {
      details.push({ field: 'format', message: "must be 'csv' or 'vcard'" });
    }
    if (typeof text !== 'string' || text.trim() === '') {
      details.push({ field: 'text', message: 'must be a non-empty string' });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    const source = format as ContactSuggestionSource;
    const content = text as string;
    if (Buffer.byteLength(content, 'utf8') > CONTACT_IMPORT_MAX_BYTES) {
      throw new ApiError(413, 'validation_failed', 'The contacts file is larger than 2 MB.', [
        { field: 'text', message: 'must be at most 2 MB' },
      ]);
    }
    const now = this.now();
    this.spendBudget(context, now);

    const parsed = source === 'csv' ? parseContactsCsv(content) : parseVcard(content);
    const expiresAt = new Date(now.getTime() + CONTACT_SUGGESTION_TTL_DAYS * 24 * HOUR_MS);
    const emails = parsed.contacts.map((contact) => contact.email);

    const updated = await this.database.transaction(context, async (runner) => {
      await this.repository.deleteExpired(runner, context, now);
      const existing =
        emails.length > 0
          ? await this.repository.existingEmails(runner, context, emails)
          : new Set<string>();
      if (parsed.contacts.length > 0) {
        await this.repository.upsert(runner, context, source, parsed.contacts, now, expiresAt);
      }
      await this.audit.append(runner, context, {
        action: 'contacts.imported',
        result: 'allowed',
        objectId: null,
        metadata: {
          source,
          imported: parsed.contacts.length - existing.size,
          updated: existing.size,
          skipped: parsed.skipped,
        },
      });
      return existing.size;
    });
    return {
      imported: parsed.contacts.length - updated,
      updated,
      skipped: parsed.skipped,
      reasons: parsed.reasons,
    };
  }

  async suggest(
    context: TenantContext,
    rawQuery: unknown,
  ): Promise<readonly ContactSuggestionView[]> {
    const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';
    if (q.length < 1 || q.length > SUGGEST_QUERY_MAX) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'q', message: `must be 1 to ${SUGGEST_QUERY_MAX} characters` },
      ]);
    }
    const now = this.now();
    const rows = await this.database.read(context, (runner) =>
      // The column collation is case-insensitive, so `Sa` finds `sara@…` and `Sara`.
      this.repository.suggest(runner, context, q, now),
    );
    return rows.map(toSuggestionView);
  }

  async clear(context: TenantContext): Promise<void> {
    await this.database.transaction(context, async (runner) => {
      await this.repository.clear(runner, context);
      await this.audit.append(runner, context, {
        action: 'contacts.cleared',
        result: 'allowed',
        objectId: null,
        metadata: {},
      });
    });
  }

  /** 10 imports per user per rolling hour, else 429. */
  private spendBudget(context: TenantContext, now: Date): void {
    const key = `${context.organizationId}:${context.userId}`;
    const since = now.getTime() - HOUR_MS;
    const recent = (this.budget.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= IMPORTS_PER_HOUR) {
      throw new ApiError(
        429,
        'rate_limited',
        MESSAGES.rateLimited,
        undefined,
        'contacts_import_rate',
      );
    }
    recent.push(now.getTime());
    this.budget.delete(key);
    this.budget.set(key, recent);
    if (this.budget.size > BUDGET_USERS_MAX) {
      const oldest = this.budget.keys().next().value;
      if (oldest !== undefined) this.budget.delete(oldest);
    }
  }
}
