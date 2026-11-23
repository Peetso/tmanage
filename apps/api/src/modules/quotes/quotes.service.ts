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
import type { OrgBrandingRepository } from '../admin/org-branding.repository.js';
import type { RecordPdfFile } from '../approvals/record-pdf.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { portalMoneyClient } from '../finance/client-invoices.service.js';
import {
  documentBrand,
  documentLanguage,
  quotePdfDocument,
  renderDocumentPdf,
} from '../finance/finance-document-pdf.js';
import type { ProjectsService } from '../projects/projects.service.js';
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
import { conversionPlan } from './quote-conversion.js';
import type { QuoteConversionWriter } from './quote-conversion.js';
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
  /** 0331. The project this accepted quote became; `null` until "Convert to project". */
  readonly convertedProjectId: string | null;
  readonly convertedAt: string | null;
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

export interface ConvertedQuote {
  readonly quote: QuoteView;
  readonly projectId: string;
  /** `false` when the quote had already been converted: the existing project is returned. */
  readonly created: boolean;
}

export interface QuotesServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: QuotesRepository;
  readonly audit: Pick<AuditService, 'record'>;
  readonly links: Pick<PublicLinksService, 'createInTransaction'>;
  /** 52-08 convert: the one project-create path, and the plan writes. */
  readonly projects?: Pick<ProjectsService, 'requireMayCreate' | 'createInTransaction'>;
  readonly conversion?: QuoteConversionWriter;
  /** 52-10: the workspace's stored branding (name, accent) on the quote PDF; absent = none. */
  readonly branding?: Pick<OrgBrandingRepository, 'findForOrganization'>;
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
        convertedProjectId: null,
        convertedAt: null,
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
   * Fix lane C (2026-11-23). Delete a DRAFT quote. A sent, accepted, declined or converted quote is
   * a 409 and stays: it is what the client saw. The number of a deleted draft is not reused unless
   * it was the newest one.
   */
  async deleteDraft(context: TenantContext, principal: Principal, quoteId: string): Promise<void> {
    this.require(principal, context);
    await this.options.database.transaction(context, async (tx) => {
      const quote = await this.load(tx, context, quoteId, true);
      if (quote.status !== 'draft') {
        throw new ApiError(409, 'conflict', 'Only a draft quote can be deleted.', [
          { field: 'quoteId', message: 'not_draft' },
        ]);
      }
      await this.audited(tx, context, 'quote.deleted', quote.id);
      if (!(await this.options.repository.deleteDraft(tx, context, quote.id))) {
        throw new ApiError(409, 'conflict', 'Only a draft quote can be deleted.', [
          { field: 'quoteId', message: 'not_draft' },
        ]);
      }
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

  /**
   * "Convert to project" on an ACCEPTED quote: one transaction creates the project through the
   * shared create path (creator row and audit included), shares it with the quote's client, adds a
   * milestone named after the quote and one work item per line, and links the quote to it. The
   * quote row is locked first, so a second convert — even a concurrent double click — finds the
   * link and returns the existing project instead of making another.
   */
  async convert(
    context: TenantContext,
    principal: Principal,
    quoteId: string,
    body: unknown,
  ): Promise<ConvertedQuote> {
    this.require(principal, context);
    const { projects, conversion } = this.options;
    if (projects === undefined || conversion === undefined) {
      throw new ApiError(500, 'internal_error', MESSAGES.internal);
    }
    const raw = (body ?? {}) as Record<string, unknown>;
    const requested = raw['workspaceId'] ?? null;
    if (requested !== null && (typeof requested !== 'string' || !isUuid(requested))) {
      throw invalid('workspaceId', 'must be a workspace id');
    }
    const seen = await this.options.database.read(context, (r) =>
      this.load(r, context, quoteId, false),
    );
    if (seen.convertedProjectId !== null) return already(seen);
    if (seen.status !== 'accepted') {
      throw new ApiError(409, 'conflict', 'Only an accepted quote can become a project.');
    }
    await projects.requireMayCreate(context, principal);

    return this.options.database.transaction(context, async (tx) => {
      const at = this.now();
      const quote = await this.load(tx, context, quoteId, true);
      if (quote.convertedProjectId !== null) return already(quote);
      if (quote.status !== 'accepted') {
        throw new ApiError(409, 'conflict', 'Only an accepted quote can become a project.');
      }
      const workspaceId = await conversion.workspaceFor(tx, context, requested);
      if (workspaceId === null)
        throw invalid('workspaceId', 'is not a workspace of this organization');
      const plan = conversionPlan(
        quote,
        await this.options.repository.lines(tx, context, quote.id),
      );
      const project = await projects.createInTransaction(tx, context, {
        workspaceId,
        name: plan.projectName,
      });
      if (
        quote.clientOrganizationId !== null &&
        (await this.options.repository.clientExists(tx, context, quote.clientOrganizationId))
      ) {
        const shareId = await conversion.shareWithClient(
          tx,
          context,
          project.id,
          quote.clientOrganizationId,
        );
        await this.options.audit.record(tx, context, {
          action: 'project.client_linked',
          result: 'allowed',
          objectId: shareId,
          metadata: { project_id: project.id, client_organization_id: quote.clientOrganizationId },
        });
      }
      await conversion.addMilestone(tx, context, project.id, plan.milestoneTitle, quote.number);
      for (const title of plan.workItemTitles) {
        await conversion.addWorkItem(tx, context, project.id, title);
      }
      if (!(await this.options.repository.markConverted(tx, context, quote.id, project.id, at))) {
        throw new ApiError(409, 'conflict', 'This quote was changed by someone else.');
      }
      await this.options.audit.record(tx, context, {
        action: 'quote.converted',
        result: 'allowed',
        objectId: quote.id,
        actorUserId: context.userId,
        metadata: { project_id: project.id, work_items: plan.workItemTitles.length },
      });
      const converted: QuoteRow = {
        ...quote,
        convertedProjectId: project.id,
        convertedAt: at,
        version: quote.version + 1,
        updatedAt: at,
      };
      return { quote: toView(converted), projectId: project.id, created: true };
    });
  }

  /** 52-10 — the quote as a PDF for the team (`project.manage`; another org's id is a 404). */
  async pdf(
    context: TenantContext,
    principal: Principal,
    quoteId: string,
    lang: unknown,
  ): Promise<RecordPdfFile> {
    this.require(principal, context);
    return this.quotePdf(context, quoteId, lang, { kind: 'team' });
  }

  /**
   * 52-10 — the client's own quote as a PDF in the portal: a quote that was sent (never a draft)
   * to the principal's own client organization; a lead's quote, another client's, a draft or an
   * unknown id is the same 404.
   */
  async portalPdf(
    context: TenantContext,
    principal: Principal,
    quoteId: string,
    lang: unknown,
  ): Promise<RecordPdfFile> {
    const clientOrganizationId = portalMoneyClient(principal);
    return this.quotePdf(context, quoteId, lang, { kind: 'client', clientOrganizationId });
  }

  private async quotePdf(
    context: TenantContext,
    quoteId: string,
    lang: unknown,
    reader:
      | { readonly kind: 'team' }
      | { readonly kind: 'client'; readonly clientOrganizationId: string },
  ): Promise<RecordPdfFile> {
    const { detail, recipient, brand } = await this.options.database.read(context, async (r) => {
      const quote = await this.load(r, context, quoteId, false);
      if (
        reader.kind === 'client' &&
        (quote.status === 'draft' || quote.clientOrganizationId !== reader.clientOrganizationId)
      ) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'quote.not_visible');
      }
      const client =
        quote.clientOrganizationId === null
          ? null
          : await this.options.repository.clientName(r, context, quote.clientOrganizationId);
      return {
        detail: toDetail(quote, await this.options.repository.lines(r, context, quote.id)),
        recipient: client ?? quote.leadName,
        brand: documentBrand(
          (await this.options.branding?.findForOrganization(r, context)) ?? null,
        ),
      };
    });
    const language = documentLanguage(lang, detail.language);
    return renderDocumentPdf(
      'quote',
      detail.number,
      quotePdfDocument({ ...detail, recipient }, language, brand),
    );
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

function already(quote: QuoteRow): ConvertedQuote {
  return { quote: toView(quote), projectId: quote.convertedProjectId ?? '', created: false };
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
    convertedProjectId: row.convertedProjectId,
    convertedAt: iso(row.convertedAt),
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
