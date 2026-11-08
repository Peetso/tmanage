import { and, asc, desc, eq, gte, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { TenantDrizzle } from '../../common/database/drizzle.js';
import { clientInvoices, expenses, fileAssets, quotes } from '../../common/database/schema.js';
import type { ClientInvoiceState, FileAssetRow } from '../../common/database/schema.js';
import type { TextMatcher } from './search-text-match.repository.js';

/**
 * 53-17 — the four kinds global search gained: client invoices, quotes, expenses and files.
 *
 * Each is a single-table scan with `organization_id = ?` leading its predicate (the tenant guard's
 * rule), bounded to `limit`. The scope the service hands in only **narrows** what is read — a kind
 * the caller can never see is not scanned at all, and a client's invoice scan is pinned to its own
 * client organization and to the states the portal shows. Every row that comes back is still
 * judged by `mayReadHit` (`search-permission.ts`), the one place the read rule lives.
 */

export type FinanceFileKind = 'invoice' | 'quote' | 'expense' | 'file';

/** The audiences a row can carry (mirrors `SearchAudience`, kept local to avoid an import cycle). */
type Audience = 'internal' | 'client_visible' | 'client_action_required';

/** What the service has already decided about the caller, used only to skip or narrow scans. */
export interface SearchReachScope {
  readonly principalKind: string;
  readonly clientOrganizationId: string | null;
  readonly membershipId: string;
  /** Internal and holds `finance.view`: may list client invoices. */
  readonly invoicesInternal: boolean;
  /** A client admin/member with `client_projection.read`: may see its own sent invoices. */
  readonly invoicesClient: boolean;
  /** Internal and holds `project.manage` at org level (the quotes list gate). */
  readonly quotes: boolean;
  /** Internal; expenses are never projected to a client. */
  readonly expenses: boolean;
  /** Holds `finance.manage`: every expense, not just own or approvable. */
  readonly expensesAll: boolean;
  /** The caller's projects, or null when its scope is the whole organization. */
  readonly projectIds: readonly string[] | null;
}

export interface FinanceFileHit {
  readonly kind: FinanceFileKind;
  readonly id: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly audience: Audience;
  readonly updatedAt: Date;
  readonly clientOrganizationId?: string | null;
  readonly state?: string;
  readonly ownerMembershipId?: string;
  readonly asset?: FileAssetRow;
}

export interface FinanceFileOptions {
  readonly organizationId: string;
  readonly matcher: TextMatcher;
  readonly limit: number;
  readonly scope: SearchReachScope;
  readonly wants: (kind: FinanceFileKind) => boolean;
  readonly projectId?: string;
  readonly audiences?: readonly Audience[];
  readonly updatedSince?: Date;
}

/** States the portal never shows a client (`client-invoices.service.ts` PORTAL_HIDDEN_STATES). */
export const CLIENT_HIDDEN_INVOICE_STATES: readonly ClientInvoiceState[] = ['draft', 'void'];

/** A draft is still the studio's own; anything sent has been shown to the client. */
function draftAudience(state: string): Audience {
  return state === 'draft' ? 'internal' : 'client_visible';
}

function audienceAdmits(audiences: readonly Audience[] | undefined, audience: Audience): boolean {
  return audiences === undefined || audiences.includes(audience);
}

export async function searchFinanceAndFiles(
  db: TenantDrizzle,
  options: FinanceFileOptions,
): Promise<FinanceFileHit[]> {
  const {
    organizationId: org,
    matcher,
    limit,
    scope,
    projectId,
    audiences,
    updatedSince,
  } = options;
  const hits: FinanceFileHit[] = [];
  const internal = scope.principalKind === 'internal';

  // ── Client invoices ───────────────────────────────────────────────────────
  if (options.wants('invoice') && (scope.invoicesInternal || scope.invoicesClient)) {
    const client = !scope.invoicesInternal;
    const text: SQL[] = [
      matcher.matches(clientInvoices.number),
      matcher.matches(clientInvoices.poNumber),
      matcher.matches(clientInvoices.notesText),
    ];
    // The internal note never matches for a client: matching on it would leak its words.
    if (!client) text.push(matcher.matches(clientInvoices.internalNote));
    const predicates: (SQL | undefined)[] = [eq(clientInvoices.organizationId, org), or(...text)];
    if (client) {
      predicates.push(eq(clientInvoices.clientOrganizationId, scope.clientOrganizationId ?? ''));
      predicates.push(notInArray(clientInvoices.state, [...CLIENT_HIDDEN_INVOICE_STATES]));
    }
    if (projectId) predicates.push(eq(clientInvoices.projectId, projectId));
    if (updatedSince) predicates.push(gte(clientInvoices.updatedAt, updatedSince));
    const rows = await db
      .select({
        id: clientInvoices.id,
        number: clientInvoices.number,
        poNumber: clientInvoices.poNumber,
        projectId: clientInvoices.projectId,
        clientOrganizationId: clientInvoices.clientOrganizationId,
        state: clientInvoices.state,
        updatedAt: clientInvoices.updatedAt,
      })
      .from(clientInvoices)
      .where(and(...predicates))
      .orderBy(desc(clientInvoices.updatedAt), asc(clientInvoices.id))
      .limit(limit);
    for (const row of rows) {
      const audience = draftAudience(row.state);
      if (!audienceAdmits(audiences, audience)) continue;
      hits.push({
        kind: 'invoice',
        id: row.id,
        title: row.number ?? row.poNumber ?? '',
        projectId: row.projectId,
        audience,
        updatedAt: row.updatedAt,
        clientOrganizationId: row.clientOrganizationId,
        state: row.state,
      });
    }
  }

  // ── Quotes (internal only; a client reads a quote through its sent link) ──
  if (options.wants('quote') && internal && scope.quotes && !projectId) {
    const predicates: (SQL | undefined)[] = [
      eq(quotes.organizationId, org),
      or(
        matcher.matches(quotes.title),
        matcher.matches(quotes.number),
        matcher.matches(quotes.leadName),
      ),
    ];
    if (updatedSince) predicates.push(gte(quotes.updatedAt, updatedSince));
    const rows = await db
      .select({
        id: quotes.id,
        number: quotes.number,
        title: quotes.title,
        status: quotes.status,
        updatedAt: quotes.updatedAt,
      })
      .from(quotes)
      .where(and(...predicates))
      .orderBy(desc(quotes.updatedAt), asc(quotes.id))
      .limit(limit);
    for (const row of rows) {
      const audience = draftAudience(row.status);
      if (!audienceAdmits(audiences, audience)) continue;
      hits.push({
        kind: 'quote',
        id: row.id,
        title: `${row.number} · ${row.title}`,
        projectId: null,
        audience,
        updatedAt: row.updatedAt,
        state: row.status,
      });
    }
  }

  // ── Expenses (internal only; own rows, or every row for finance.manage) ───
  if (
    options.wants('expense') &&
    internal &&
    scope.expenses &&
    audienceAdmits(audiences, 'internal')
  ) {
    const predicates: (SQL | undefined)[] = [
      eq(expenses.organizationId, org),
      or(matcher.matches(expenses.note), matcher.matches(expenses.category)),
    ];
    if (!scope.expensesAll) {
      // Own rows, or rows on a project the caller is on (an approver's reach); the service then
      // keeps only the rows the expense's own read would admit.
      const reach: SQL[] = [eq(expenses.membershipId, scope.membershipId)];
      if (scope.projectIds === null) reach.push(eq(expenses.organizationId, org));
      else if (scope.projectIds.length > 0) {
        reach.push(inArray(expenses.projectId, [...scope.projectIds]));
      }
      predicates.push(or(...reach));
    }
    if (projectId) predicates.push(eq(expenses.projectId, projectId));
    if (updatedSince) predicates.push(gte(expenses.updatedAt, updatedSince));
    const rows = await db
      .select({
        id: expenses.id,
        note: expenses.note,
        category: expenses.category,
        projectId: expenses.projectId,
        membershipId: expenses.membershipId,
        updatedAt: expenses.updatedAt,
      })
      .from(expenses)
      .where(and(...predicates))
      .orderBy(desc(expenses.updatedAt), asc(expenses.id))
      .limit(limit);
    for (const row of rows) {
      hits.push({
        kind: 'expense',
        id: row.id,
        title: row.note !== null && row.note !== '' ? row.note : row.category,
        projectId: row.projectId,
        audience: 'internal',
        updatedAt: row.updatedAt,
        ownerMembershipId: row.membershipId,
      });
    }
  }

  // ── Files (ready, not deleted; the asset row rides along for the client relation) ──
  if (options.wants('file')) {
    const predicates: (SQL | undefined)[] = [
      eq(fileAssets.organizationId, org),
      isNull(fileAssets.deletedAt),
      eq(fileAssets.status, 'ready'),
      matcher.matches(fileAssets.name),
    ];
    if (projectId) predicates.push(eq(fileAssets.projectId, projectId));
    if (audiences && audiences.length > 0) {
      predicates.push(inArray(fileAssets.audience, [...audiences]));
    }
    if (scope.projectIds !== null) {
      if (scope.projectIds.length === 0) return hits;
      predicates.push(inArray(fileAssets.projectId, [...scope.projectIds]));
    }
    if (updatedSince) predicates.push(gte(fileAssets.updatedAt, updatedSince));
    const rows = await db
      .select()
      .from(fileAssets)
      .where(and(...predicates))
      .orderBy(desc(fileAssets.updatedAt), asc(fileAssets.id))
      .limit(limit);
    for (const row of rows) {
      hits.push({
        kind: 'file',
        id: row.id,
        title: row.name,
        projectId: row.projectId,
        audience: row.audience,
        updatedAt: row.updatedAt,
        clientOrganizationId: row.clientOrganizationId,
        asset: row,
      });
    }
  }

  return hits;
}
