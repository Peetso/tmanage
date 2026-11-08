import {
  CONTACT_IMPORT_MAX_BYTES,
  authorize,
  contactsCsvHeader,
  isValidContactMapping,
  parseContactsCsv,
  parseVcard,
} from '@tmanage/domain';
import type {
  ContactColumnMapping,
  ContactParseResult,
  ContactRecord,
  ContactSkipReasons,
  Principal,
} from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ClientOrganizationsRepository } from '../clients/client-organizations.repository.js';
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
/** r46: previews are cheaper than imports (nothing written) but still parse up to 2 MB. */
export const PREVIEWS_PER_HOUR = 60;
/** r46: the preview shows this many rows; the error list is complete (≤ 5,000). */
export const PREVIEW_ROWS = 200;
/** r46: at most this many client companies are created by one import. */
export const IMPORT_CLIENTS_MAX = 200;
/** Client companies are read in pages of this size when matching names. */
const CLIENT_PAGE = 200;
export const SUGGEST_QUERY_MAX = 100;
const HOUR_MS = 60 * 60 * 1000;
/** The in-memory budget forgets the oldest users beyond this many (bounded memory). */
const BUDGET_USERS_MAX = 10_000;

export interface ImportContactsBody {
  readonly format?: unknown;
  readonly text?: unknown;
  /** r46: CSV only — which column holds the e-mail / name / company (0-based). */
  readonly mapping?: unknown;
  /** r46: also add the file's new companies as client companies (needs `org.manage`). */
  readonly createClients?: unknown;
}

export interface ContactImportView {
  readonly imported: number;
  readonly updated: number;
  readonly skipped: number;
  readonly reasons: ContactSkipReasons;
  /** r46: client companies created from the Company column (0 unless asked). */
  readonly clientsCreated: number;
}

/** r46: one previewed record — the parser's outcome, plus "already in your list". */
export interface ContactPreviewRow {
  readonly line: number;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly company: string | null;
  readonly status: 'new' | 'existing' | 'duplicate' | 'missing_email' | 'invalid_email';
}

export interface ContactImportPreviewView {
  readonly format: 'csv' | 'vcard';
  /** CSV header cells (null for vCard). */
  readonly header: readonly string[] | null;
  /** The mapping used (the caller's, else the guess; null for vCard or no e-mail column). */
  readonly mapping: ContactColumnMapping | null;
  readonly counts: {
    readonly total: number;
    readonly new: number;
    readonly existing: number;
    readonly duplicate: number;
    readonly invalid: number;
    readonly overLimit: number;
  };
  /** The first {@link PREVIEW_ROWS} records, in file order. */
  readonly rows: readonly ContactPreviewRow[];
  /** Every record that will not be imported (the error report's rows). */
  readonly errors: readonly ContactRecord[];
  /** Distinct companies of importable rows; `isNew` when no client company has that name. */
  readonly companies: readonly { readonly name: string; readonly isNew: boolean }[];
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
  readonly clients?: Pick<ClientOrganizationsRepository, 'list' | 'create'>;
}

export function toSuggestionView(row: ContactSuggestionRow): ContactSuggestionView {
  return { displayName: row.displayName, email: row.email, company: row.company };
}

export class ContactSuggestionsService {
  private readonly audit: Pick<AuditEventsRepository, 'append'>;
  private readonly now: () => Date;
  private readonly clients: Pick<ClientOrganizationsRepository, 'list' | 'create'>;
  /** `org:user` → import instants within the last hour. One Node process serves the API. */
  private readonly budget = new Map<string, number[]>();

  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: ContactSuggestionsRepository,
    deps: ContactSuggestionsDeps = {},
  ) {
    this.audit = deps.audit ?? new AuditEventsRepository();
    this.now = deps.now ?? (() => new Date());
    this.clients = deps.clients ?? new ClientOrganizationsRepository();
  }

  /**
   * r46 — what an import of this file would do, without writing: every record's outcome, which
   * addresses the caller already has, and which companies are new client companies. Counts against
   * its own hourly budget ({@link PREVIEWS_PER_HOUR}).
   */
  async preview(
    context: TenantContext,
    body: ImportContactsBody,
  ): Promise<ContactImportPreviewView> {
    const { source, content, mapping } = validatedBody(body);
    const now = this.now();
    this.spendBudget(context, now, 'preview', PREVIEWS_PER_HOUR);
    const trace: ContactRecord[] = [];
    const parsed = parseFile(source, content, mapping, trace);
    const guessed = source === 'csv' ? contactsCsvHeader(content) : null;
    const emails = parsed.contacts.map((contact) => contact.email);
    const { existing, clientNames } = await this.database.read(context, async (runner) => ({
      existing:
        emails.length > 0
          ? await this.repository.existingEmails(runner, context, emails)
          : new Set<string>(),
      clientNames: await this.clientNames(runner, context),
    }));
    const statusOf = (record: ContactRecord): ContactPreviewRow['status'] =>
      record.outcome === 'ok'
        ? record.email !== null && existing.has(record.email)
          ? 'existing'
          : 'new'
        : record.outcome;
    const companies = new Map<string, { name: string; isNew: boolean }>();
    for (const contact of parsed.contacts) {
      const key = contact.company?.toLocaleLowerCase();
      if (contact.company === null || key === undefined || companies.has(key)) continue;
      companies.set(key, { name: contact.company, isNew: !clientNames.has(key) });
    }
    return {
      format: source,
      header: guessed ? guessed.header : null,
      mapping: mapping ?? guessed?.mapping ?? null,
      counts: {
        total: trace.length + parsed.reasons.over_limit,
        new: parsed.contacts.length - existing.size,
        existing: existing.size,
        duplicate: parsed.reasons.duplicate,
        invalid: parsed.reasons.missing_email + parsed.reasons.invalid_email,
        overLimit: parsed.reasons.over_limit,
      },
      rows: trace.slice(0, PREVIEW_ROWS).map((record) => ({
        line: record.line,
        displayName: record.displayName,
        email: record.email,
        company: record.company,
        status: statusOf(record),
      })),
      errors: trace.filter((record) => record.outcome !== 'ok'),
      companies: [...companies.values()].slice(0, IMPORT_CLIENTS_MAX),
    };
  }

  async importFile(
    context: TenantContext,
    body: ImportContactsBody,
    principal?: Principal,
  ): Promise<ContactImportView> {
    const { source, content, mapping } = validatedBody(body);
    const createClients = body?.createClients === true;
    if (createClients && (principal === undefined || !mayCreateClients(principal, context))) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'contacts_clients_forbidden',
      );
    }
    const now = this.now();
    this.spendBudget(context, now);

    const parsed = parseFile(source, content, mapping, null);
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
      const clientsCreated = createClients
        ? await this.createClientCompanies(runner, context, parsed)
        : 0;
      await this.audit.append(runner, context, {
        action: 'contacts.imported',
        result: 'allowed',
        objectId: null,
        metadata: {
          source,
          imported: parsed.contacts.length - existing.size,
          updated: existing.size,
          skipped: parsed.skipped,
          clients_created: clientsCreated,
        },
      });
      return { updated: existing.size, clientsCreated };
    });
    return {
      imported: parsed.contacts.length - updated.updated,
      updated: updated.updated,
      skipped: parsed.skipped,
      reasons: parsed.reasons,
      clientsCreated: updated.clientsCreated,
    };
  }

  /** Lower-cased names of the studio's active client companies. */
  private async clientNames(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<Set<string>> {
    const names = new Set<string>();
    let after: string | undefined;
    for (;;) {
      const page = await this.clients.list(runner, context, {
        limit: CLIENT_PAGE,
        ...(after !== undefined ? { after } : {}),
      });
      for (const row of page) names.add(row.name.toLocaleLowerCase());
      if (page.length < CLIENT_PAGE) return names;
      after = page[page.length - 1]?.id;
    }
  }

  /** Create a client company per new company name of the file (first spelling wins), capped. */
  private async createClientCompanies(
    runner: TenantQueryRunner,
    context: TenantContext,
    parsed: ContactParseResult,
  ): Promise<number> {
    const known = await this.clientNames(runner, context);
    let created = 0;
    for (const contact of parsed.contacts) {
      if (created >= IMPORT_CLIENTS_MAX) break;
      const name = contact.company?.slice(0, 190);
      if (name === undefined || known.has(name.toLocaleLowerCase())) continue;
      known.add(name.toLocaleLowerCase());
      const row = await this.clients.create(runner, context, { name });
      await this.audit.append(runner, context, {
        action: 'client_organization.created',
        result: 'allowed',
        objectId: row.id,
        metadata: { via: 'contacts_import' },
      });
      created += 1;
    }
    return created;
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

  /** 10 imports (or 60 previews) per user per rolling hour, else 429. */
  private spendBudget(
    context: TenantContext,
    now: Date,
    kind: 'import' | 'preview' = 'import',
    limit: number = IMPORTS_PER_HOUR,
  ): void {
    const key = `${context.organizationId}:${context.userId}${kind === 'import' ? '' : ':preview'}`;
    const since = now.getTime() - HOUR_MS;
    const recent = (this.budget.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= limit) {
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

/** Shape, size and mapping checks shared by preview and import: 400 / 413 before any read. */
function validatedBody(body: ImportContactsBody): {
  source: ContactSuggestionSource;
  content: string;
  mapping: ContactColumnMapping | undefined;
} {
  const format = body?.format;
  const text = body?.text;
  const details: { field: string; message: string }[] = [];
  if (format !== 'csv' && format !== 'vcard') {
    details.push({ field: 'format', message: "must be 'csv' or 'vcard'" });
  }
  if (typeof text !== 'string' || text.trim() === '') {
    details.push({ field: 'text', message: 'must be a non-empty string' });
  }
  if (body?.createClients !== undefined && typeof body.createClients !== 'boolean') {
    details.push({ field: 'createClients', message: 'must be a boolean' });
  }
  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  const content = text as string;
  if (Buffer.byteLength(content, 'utf8') > CONTACT_IMPORT_MAX_BYTES) {
    throw new ApiError(413, 'validation_failed', 'The contacts file is larger than 2 MB.', [
      { field: 'text', message: 'must be at most 2 MB' },
    ]);
  }
  let mapping: ContactColumnMapping | undefined;
  if (body?.mapping !== undefined && body.mapping !== null) {
    const width = format === 'csv' ? contactsCsvHeader(content).header.length : 0;
    if (!isValidContactMapping(body.mapping, width)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'mapping', message: 'must name existing CSV columns (e-mail required)' },
      ]);
    }
    const m = body.mapping;
    mapping = { email: m.email, name: m.name ?? null, company: m.company ?? null };
  }
  return { source: format as ContactSuggestionSource, content, mapping };
}

function parseFile(
  source: ContactSuggestionSource,
  content: string,
  mapping: ContactColumnMapping | undefined,
  trace: ContactRecord[] | null,
): ContactParseResult {
  return source === 'csv' ? parseContactsCsv(content, mapping, trace) : parseVcard(content, trace);
}

/** Creating client companies is the same right as the Clients screen's "Add client": `org.manage`. */
function mayCreateClients(principal: Principal, context: TenantContext): boolean {
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
