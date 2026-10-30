import { authorize, uuidv7 } from '@tmanage/domain';
import type { AuditAction, Principal } from '@tmanage/domain';
import { QUOTE_STATUSES } from '../../common/database/schema.js';
import type { QuoteLineRow, QuoteRow, QuoteStatus } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { PublicLinksService } from '../public-links/public-links.service.js';
import {
  computeTotals,
  contentHash,
  invalid,
  isUuid,
  validateEmail,
  validateQuote,
} from './quote-content.js';
import type { QuoteInput } from './quote-content.js';
import { QUOTE_TARGET_TYPE } from './quote-target.js';
import type { QuotesRepository } from './quotes.repository.js';

/**
 * 52-08 — quotes, member side: create, list, get, update a draft, send.
 *
 * A quote is an organization-level object (it belongs to a client, not a project), so every call
 * authorizes `project.manage` at organization scope — the capability 56-07 already asks to issue a
 * `quote` link. A quote of another organization is a 404. Totals are always recomputed on the
 * server. Sending freezes the quote (status `sent` + `content_hash`) and issues the 56-07 link in
 * the same transaction; from then on the quote is immutable and only its link's decision moves it.
 */

const DAY_MS = 86_400_000;
const MAX_LINK_DAYS = 30;
const MAX_LIST = 100;

export interface QuoteView {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly status: QuoteStatus;
  readonly clientOrganizationId: string | null;
  readonly leadName: string | null;
  readonly leadEmail: string | null;
  readonly language: string;
  readonly currency: string;
  readonly validUntil: string;
  readonly subtotalMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly contentHash: string | null;
  readonly sentAt: string | null;
  readonly sentLinkId: string | null;
  readonly decidedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QuoteDetail extends QuoteView {
  readonly terms: string | null;
  readonly notes: string | null;
  readonly lines: readonly {
    readonly position: number;
    readonly description: string;
    readonly unit: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly taxBp: number;
    readonly lineNetMinor: number;
    readonly lineTaxMinor: number;
  }[];
}

export interface SentQuote {
  readonly quote: QuoteView;
  /** The accept link's token: in this answer exactly once, never again. */
  readonly link: { readonly id: string; readonly token: string; readonly expiresAt: string };
}

export interface QuotesServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: QuotesRepository;
  readonly audit: Pick<AuditService, 'record'>;
  readonly links: Pick<PublicLinksService, 'createInTransaction'>;
  readonly now?: () => Date;
}

export class QuotesService {
  private readonly now: () => Date;

  constructor(private readonly options: QuotesServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(
    context: TenantContext,
    principal: Principal,
    query: { readonly status?: unknown; readonly limit?: unknown },
  ): Promise<readonly QuoteView[]> {
    this.require(principal, context);
    let status: QuoteStatus | undefined;
    if (query.status !== undefined) {
      status = QUOTE_STATUSES.find((s) => s === query.status);
      if (status === undefined)
        throw invalid('status', `must be one of ${QUOTE_STATUSES.join(', ')}`);
    }
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
      throw invalid('limit', `must be a whole number from 1 to ${MAX_LIST}`);
    }
    const rows = await this.options.database.read(context, (r) =>
      this.options.repository.list(r, context, { ...(status ? { status } : {}), limit }),
    );
    return rows.map(toView);
  }

  async get(context: TenantContext, principal: Principal, quoteId: string): Promise<QuoteDetail> {
    this.require(principal, context);
    return this.options.database.read(context, async (r) => {
      const quote = await this.load(r, context, quoteId, false);
      return toDetail(quote, await this.options.repository.lines(r, context, quote.id));
    });
  }

  async create(context: TenantContext, principal: Principal, body: unknown): Promise<QuoteDetail> {
    this.require(principal, context);
    const at = this.now();
    const input = validateQuote(body, at);
    return this.options.database.transaction(context, async (tx) => {
      await this.checkClient(tx, context, input);
      const seq = await this.options.repository.nextSeq(tx, context);
      const totals = computeTotals(input.lines);
      const row: QuoteRow = {
        id: uuidv7(),
        organizationId: context.organizationId,
        seq,
        number: `Q-${String(seq).padStart(4, '0')}`,
        clientOrganizationId: input.clientOrganizationId,
        leadName: input.leadName,
        leadEmail: input.leadEmail,
        title: input.title,
        language: input.language,
        currency: input.currency,
        status: 'draft',
        validUntil: input.validUntil,
        subtotalMinor: totals.subtotalMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        termsText: input.termsText,
        notesText: input.notesText,
        contentHash: null,
        sentAt: null,
        sentLinkId: null,
        decidedAt: null,
        createdByUserId: context.userId,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      await this.options.repository.insert(tx, row);
      await this.options.repository.replaceLines(tx, context, row.id, totals.lines, at);
      await this.audited(tx, context, 'quote.created', row.id);
      return toDetail(row, await this.options.repository.lines(tx, context, row.id));
    });
  }

  /** Replace a DRAFT's content; `version` must match (optimistic lock). A sent quote is a 409. */
  async updateDraft(
    context: TenantContext,
    principal: Principal,
    quoteId: string,
    body: unknown,
  ): Promise<QuoteDetail> {
    this.require(principal, context);
    const at = this.now();
    const input = validateQuote(body, at);
    const version = (body as Record<string, unknown> | null)?.['version'];
    return this.options.database.transaction(context, async (tx) => {
      const quote = await this.load(tx, context, quoteId, true);
      if (quote.status !== 'draft') {
        throw new ApiError(409, 'conflict', 'A sent quote cannot be changed.');
      }
      if (version !== undefined && version !== quote.version) {
        throw new ApiError(409, 'conflict', 'This quote was changed by someone else.', [
          { field: 'version', message: 'stale' },
        ]);
      }
      await this.checkClient(tx, context, input);
      const totals = computeTotals(input.lines);
      const change = {
        clientOrganizationId: input.clientOrganizationId,
        leadName: input.leadName,
        leadEmail: input.leadEmail,
        title: input.title,
        language: input.language,
        currency: input.currency,
        validUntil: input.validUntil,
        subtotalMinor: totals.subtotalMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        termsText: input.termsText,
        notesText: input.notesText,
        version: quote.version + 1,
        updatedAt: at,
      };
      await this.options.repository.update(tx, context, quote.id, change);
      await this.options.repository.replaceLines(tx, context, quote.id, totals.lines, at);
      await this.audited(tx, context, 'quote.updated', quote.id);
      return toDetail(
        { ...quote, ...change },
        await this.options.repository.lines(tx, context, quote.id),
      );
    });
  }

  /**
   * Freeze a draft (status `sent`, `content_hash`) and issue its 56-07 `quote` link to `to`, in
   * one transaction. The link always requires the e-mail code for `accept` and never outlives the
   * quote's validity (capped at 30 days).
   */
  async send(
    context: TenantContext,
    principal: Principal,
    quoteId: string,
    body: unknown,
  ): Promise<SentQuote> {
    this.require(principal, context);
    const raw = (body ?? {}) as Record<string, unknown>;
    const to = validateEmail(raw['to'], 'to');
    return this.options.database.transaction(context, async (tx) => {
      const at = this.now();
      const quote = await this.load(tx, context, quoteId, true);
      if (quote.status !== 'draft') {
        throw new ApiError(409, 'conflict', 'This quote has already been sent.');
      }
      if (quote.validUntil <= at) throw invalid('validUntil', 'has passed; edit the draft first');
      const lines = await this.options.repository.lines(tx, context, quote.id);
      if (lines.length === 0) throw invalid('lines', 'a quote needs at least one line');
      const hash = contentHash(quote, lines);
      const days = Math.min(
        MAX_LINK_DAYS,
        Math.max(1, Math.ceil((quote.validUntil.getTime() - at.getTime()) / DAY_MS)),
      );
      await this.options.repository.update(tx, context, quote.id, {
        status: 'sent',
        contentHash: hash,
        sentAt: at,
        version: quote.version + 1,
        updatedAt: at,
      });
      const link = await this.options.links.createInTransaction(tx, context, principal, {
        kind: 'quote',
        targetType: QUOTE_TARGET_TYPE,
        targetId: quote.id,
        audienceEmail: to,
        requireCode: true,
        language: quote.language,
        expiresInDays: days,
        maxUses: null,
      });
      await this.options.repository.update(tx, context, quote.id, { sentLinkId: link.id });
      await this.audited(tx, context, 'quote.sent', quote.id);
      const sent: QuoteRow = {
        ...quote,
        status: 'sent',
        contentHash: hash,
        sentAt: at,
        sentLinkId: link.id,
        version: quote.version + 1,
        updatedAt: at,
      };
      return {
        quote: toView(sent),
        link: { id: link.id, token: link.token, expiresAt: link.expiresAt },
      };
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async load(
    runner: TenantQueryRunner,
    context: TenantContext,
    quoteId: string,
    lock: boolean,
  ): Promise<QuoteRow> {
    const quote = isUuid(quoteId)
      ? await this.options.repository.find(runner, context, quoteId, lock)
      : null;
    if (quote === null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'quote.not_visible');
    }
    return quote;
  }

  private async checkClient(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: QuoteInput,
  ): Promise<void> {
    if (
      input.clientOrganizationId !== null &&
      !(await this.options.repository.clientExists(runner, context, input.clientOrganizationId))
    ) {
      throw invalid('clientOrganizationId', 'is not a client of this organization');
    }
  }

  private require(principal: Principal, context: TenantContext): void {
    const decision = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!decision.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'quote.manage_denied');
    }
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    quoteId: string,
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId: quoteId,
      actorUserId: context.userId,
      metadata: {},
    });
  }
}

function iso(at: Date | null): string | null {
  return at === null ? null : at.toISOString();
}

export function toView(row: QuoteRow): QuoteView {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    clientOrganizationId: row.clientOrganizationId,
    leadName: row.leadName,
    leadEmail: row.leadEmail,
    language: row.language,
    currency: row.currency,
    validUntil: row.validUntil.toISOString(),
    subtotalMinor: row.subtotalMinor,
    taxMinor: row.taxMinor,
    totalMinor: row.totalMinor,
    contentHash: row.contentHash,
    sentAt: iso(row.sentAt),
    sentLinkId: row.sentLinkId,
    decidedAt: iso(row.decidedAt),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: QuoteRow, lines: readonly QuoteLineRow[]): QuoteDetail {
  return {
    ...toView(row),
    terms: row.termsText,
    notes: row.notesText,
    lines: lines.map((l) => ({
      position: l.position,
      description: l.description,
      unit: l.unit,
      quantity: l.quantityCenti / 100,
      unitPriceMinor: l.unitPriceMinor,
      taxBp: l.taxBp,
      lineNetMinor: l.lineNetMinor,
      lineTaxMinor: l.lineTaxMinor,
    })),
  };
}
