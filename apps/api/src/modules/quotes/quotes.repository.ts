import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientOrganizations, quoteLines, quotes } from '../../common/database/schema.js';
import type { QuoteLineRow, QuoteRow, QuoteStatus } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ComputedLine } from './quote-content.js';

/**
 * 52-08 — `quotes` and `quote_lines` (0259). Every method takes the unit of work and the
 * `TenantContext` and puts the tenant predicate on every statement, so another organization's
 * quote is simply absent. The outsider path reaches these methods only through the 56-07 `quote`
 * target adapter, under a service context bound to the link's organization.
 */
export class QuotesRepository {
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    quoteId: string,
    lock = false,
  ): Promise<QuoteRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(quotes)
      .where(and(eq(quotes.organizationId, context.organizationId), eq(quotes.id, quoteId)))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async lines(
    runner: TenantQueryRunner,
    context: TenantContext,
    quoteId: string,
  ): Promise<readonly QuoteLineRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(quoteLines)
      .where(
        and(eq(quoteLines.organizationId, context.organizationId), eq(quoteLines.quoteId, quoteId)),
      )
      .orderBy(asc(quoteLines.position));
  }

  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: { readonly status?: QuoteStatus; readonly limit: number },
  ): Promise<readonly QuoteRow[]> {
    const predicates = [eq(quotes.organizationId, context.organizationId)];
    if (options.status !== undefined) predicates.push(eq(quotes.status, options.status));
    return tenantDrizzle(runner)
      .select()
      .from(quotes)
      .where(and(...predicates))
      .orderBy(desc(quotes.createdAt), desc(quotes.id))
      .limit(options.limit);
  }

  /** The client exists, is live and belongs to this organization. */
  async clientExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrganizationId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: clientOrganizations.id })
      .from(clientOrganizations)
      .where(
        and(
          eq(clientOrganizations.organizationId, context.organizationId),
          eq(clientOrganizations.id, clientOrganizationId),
          isNull(clientOrganizations.archivedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The next per-organization sequence number; the locking read serializes two creates. */
  async nextSeq(runner: TenantQueryRunner, context: TenantContext): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ max: sql<number | null>`max(${quotes.seq})` })
      .from(quotes)
      .where(eq(quotes.organizationId, context.organizationId))
      .for('update');
    return Number(rows[0]?.max ?? 0) + 1;
  }

  async insert(runner: TenantQueryRunner, row: QuoteRow): Promise<void> {
    await tenantDrizzle(runner).insert(quotes).values(row);
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    quoteId: string,
    change: Partial<Omit<QuoteRow, 'id' | 'organizationId'>>,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(quotes)
      .set(change)
      .where(and(eq(quotes.organizationId, context.organizationId), eq(quotes.id, quoteId)));
  }

  /** Replace a draft's lines as a set. */
  async replaceLines(
    runner: TenantQueryRunner,
    context: TenantContext,
    quoteId: string,
    lines: readonly ComputedLine[],
    at: Date,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(quoteLines)
      .where(
        and(eq(quoteLines.organizationId, context.organizationId), eq(quoteLines.quoteId, quoteId)),
      );
    if (lines.length === 0) return;
    await db.insert(quoteLines).values(
      lines.map((line) => ({
        id: uuidv7(),
        organizationId: context.organizationId,
        quoteId,
        position: line.position,
        description: line.description,
        unit: line.unit,
        quantityCenti: line.quantityCenti,
        unitPriceMinor: line.unitPriceMinor,
        taxBp: line.taxBp,
        lineNetMinor: line.lineNetMinor,
        lineTaxMinor: line.lineTaxMinor,
        createdAt: at,
      })),
    );
  }

  /**
   * The one terminal move of a sent quote, bound to the hash the link was issued under. `false`
   * when the quote is no longer `sent` or its content is not the content the link showed.
   */
  async decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    quoteId: string,
    contentHash: string,
    status: QuoteStatus,
    at: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(quotes)
      .set({ status, decidedAt: at, updatedAt: at, version: sql`${quotes.version} + 1` })
      .where(
        and(
          eq(quotes.organizationId, context.organizationId),
          eq(quotes.id, quoteId),
          eq(quotes.status, 'sent'),
          eq(quotes.contentHash, contentHash),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
