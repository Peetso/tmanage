import { createHash } from 'node:crypto';
import {
  MoneyError,
  agingBucket,
  amountDue,
  amountInWords,
  applyPayment,
  authorize,
  canUseLabel,
  creditNoteTotals,
  defaultLabelFor,
  divideHalfUp,
  currencyDigits,
  invoiceStanding,
  invoiceTotals,
  isCreditable,
  isValidTaxRef,
  labelCopy,
  localDateOf,
  nextInvoiceState,
  resolvedRegime,
  taxNoticeRequired,
  uuidv7,
  xmlHash,
} from '@tmanage/domain';
import type {
  AgingBucket,
  AuditAction,
  Capability,
  InvoiceLineInput,
  InvoiceStanding,
  Phase1QrInput,
  Principal,
  TaxRateTotal,
} from '@tmanage/domain';
import { phase2Qr, verifyXmlSignature } from '@tmanage/domain/zatca-sign';
import { withTemplateKey } from '@tmanage/mail';
import { attachIfFits } from '@tmanage/mail';
import type { MailAttachment, Mailer, MailMessage } from '@tmanage/mail';
import type {
  ClientCreditNoteLineRow,
  ClientCreditNoteRow,
  ClientInvoiceLineRow,
  ClientInvoicePaymentRow,
  ClientInvoiceRow,
  ClientOrganizationBillingRow,
} from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { escapeHtml, renderActionEmail } from '../../common/email/action-email.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { OrgBrandingRepository } from '../admin/org-branding.repository.js';
import type { RecordPdfFile } from '../approvals/record-pdf.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsRepository } from '../inbox/notifications.repository.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { verifyReauthToken } from '../identity/reauth-token.js';
import {
  ALLOW_OVERPAYMENT_SETTING_KEY,
  DEFAULT_STEP_UP_SEND_MINOR,
  LIST_PAGE,
  MAX_INVOICE_LINES,
  PORTAL_SHOW_NAMES_SETTING_KEY,
  STEP_UP_SEND_SETTING_KEY,
  addDays,
  arabicExpenseDescription,
  idempotencyKeyHash,
  invalid,
  invoiceContentHash,
  isoDay,
  pulledSourceTypes,
  sourceIdsOf,
  unitLabel,
  validateCreate,
  validateCreditNote,
  validateEmail,
  validateLabel,
  validateListQuery,
  validatePatch,
  validatePayment,
  validatePull,
  validateReason,
  validateSend,
  validateTaxRegistration,
} from './client-invoices-rules.js';
import type { LineInput } from './client-invoices-rules.js';
import type { ClientInvoicesRepository, InvoiceChange } from './client-invoices.repository.js';
import type { DocumentSequenceService } from './document-sequences.js';
import {
  chainLink,
  creditNoteUblLines,
  einvoiceXml,
  invoiceDocument,
  invoiceUblLines,
  qrFor,
  sellerFromSnapshot,
  twoPlaces,
  ublProfileOf,
} from './einvoice-rules.js';
import { SigningFailure } from './einvoice-signing.service.js';
import type { DocumentSignature, EinvoiceSigningService } from './einvoice-signing.service.js';
import type { OrgSecretsRepository } from './org-secrets.repository.js';
import type { EinvoiceDocument } from './einvoice-rules.js';
import { defaultProfile, taxNoticeFor } from './finance-rules.js';
import {
  documentBrand,
  documentDescription,
  documentLanguage,
  formatMinor,
  invoicePdfDocument,
  renderDocumentPdf,
} from './finance-document-pdf.js';
import type { DocumentBrand } from './finance-document-pdf.js';
import type { FinanceProfileValues } from './finance-rules.js';
import type { FinanceRepository } from './finance.repository.js';
import { FINANCE_MANAGE, FINANCE_VIEW } from './finance.service.js';
import { convertMinor, expenseLines, quoteLines, retainerLine, timeLines } from './invoice-pull.js';
import type { PulledLine } from './invoice-pull.js';

/**
 * 52-09 — client invoices: draft, pull-in, edit, send (ONE transaction), mark sent, payments, void,
 * credit notes, reminders, aging, the print view and the client's portal projection.
 *
 * Capability stand-ins (no `capabilities.ts` edit): `invoice.view` → `finance.view`;
 * `invoice.manage` / `invoice.send` / `invoice.record_payment` → `finance.manage`. A send whose
 * total (in the base currency) is above the org setting `finance.step_up_send_minor` (default
 * 5,000,000 minor) needs a fresh `x-reauth-token` — the step-up `POST /v1/auth/reauth` issues.
 * Portal: `client_projection.read`, a client admin or member, and the invoice's client organization
 * = the principal's own; anything else is a 404, as for an unknown invoice.
 *
 * Totals are always recomputed on the server from the lines (`invoiceTotals`). A sent invoice is
 * frozen by the 0301 triggers; a correction is a credit note. 52-10: the PDF is a download (team
 * and portal). INVMAIL: with `attachPdf` the send mail also carries that PDF, built after the
 * commit from the stored document in its own language, when it fits the mailer's size limit; the
 * mail keeps the portal link either way.
 */

export interface InvoiceLineView {
  readonly id: string;
  readonly position: number;
  readonly sourceType: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly quantity: number;
  readonly unit: string;
  readonly unitPriceMinor: number;
  readonly discountBp: number;
  readonly taxBp: number;
  readonly lineDiscountMinor: number;
  readonly lineNetMinor: number;
  readonly lineTaxMinor: number;
  readonly lineGrossMinor: number;
  readonly groupKey: string | null;
}

export interface InvoiceSummary {
  readonly id: string;
  readonly number: string | null;
  readonly clientOrganizationId: string;
  readonly kind: string;
  readonly state: string;
  readonly currency: string;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly amountDueMinor: number;
  readonly overdue: boolean;
}

export interface InvoiceView extends InvoiceSummary {
  readonly projectId: string | null;
  readonly retainerPeriodId: string | null;
  readonly quoteId: string | null;
  readonly language: string;
  readonly documentLabel: string;
  /** 52-28: the reference the agency entered (ETA uuid / ZATCA uuid / accounting-tool ref). */
  readonly taxRegistrationRef: string | null;
  readonly taxRegisteredAt: string | null;
  /** 52-28: the "not a tax invoice" line went out with the sent document. */
  readonly taxNoticeShown: boolean;
  readonly supplyDate: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly baseCurrency: string;
  readonly fxRate: string | null;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly depositAppliedMinor: number;
  readonly taxByRate: readonly TaxRateTotal[];
  readonly amountInWords: { readonly en: string; readonly ar: string };
  readonly poNumber: string | null;
  readonly notes: string | null;
  readonly internalNote: string | null;
  readonly terms: string | null;
  readonly contentHash: string | null;
  readonly sentAt: string | null;
  readonly sentTo: string | null;
  readonly viewedAt: string | null;
  readonly paidAt: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly InvoiceLineView[];
  readonly payments: readonly {
    readonly id: string;
    readonly paidOn: string;
    readonly amountMinor: number;
    readonly method: string;
    readonly reference: string | null;
    readonly note: string | null;
  }[];
  readonly creditNotes: readonly {
    readonly id: string;
    readonly number: string;
    readonly reason: string;
    readonly totalMinor: number;
    readonly issuedAt: string;
  }[];
  /** 52-10: no stored PDF file; the PDF is drawn on each `…/pdf` download. */
  readonly pdf: null;
  /** 52-12 (0311): the hash-chain facts; null when the invoice is outside the chain. */
  readonly einvoice: { readonly status: string; readonly icv: number | null } | null;
}

/** 52-12 (R21-d): `GET …/client-invoices/:id/einvoice`. */
export interface EinvoiceView {
  readonly invoiceId: string;
  readonly number: string;
  readonly regime: 'zatca' | 'pint_ae';
  readonly status: string;
  readonly icv: number | null;
  readonly pih: string | null;
  readonly xmlHash: string | null;
  /** The rebuilt XML's hash equals the stored one; null when no hash was stored (pint_ae). */
  readonly hashMatches: boolean | null;
  /** ZATCA TLV base64: Phase 1 (tags 1–5), Phase 2 (tags 1–9) when signed; null for pint_ae. */
  readonly qr: string | null;
  readonly xml: string;
  /** 52-12 (R22-a): base64 DER ECDSA signature of the XML; null when unsigned. */
  readonly signature: string | null;
  /** SHA-256 of the signing certificate; null when unsigned. */
  readonly certFingerprint: string | null;
  /** The rebuilt XML verifies against the stored signature (second tamper check); null unsigned. */
  readonly signatureValid: boolean | null;
}

export interface PullResult {
  readonly invoice: InvoiceView;
  /** Billable time in the window still waiting on an approval: never pulled. */
  readonly waiting: { readonly minutes: number };
  /** Approved time without a rate snapshot: left out rather than priced at zero. */
  readonly unpriced: { readonly minutes: number };
}

export interface AgingView {
  readonly asOf: string;
  readonly currencies: readonly {
    readonly currency: string;
    readonly buckets: Readonly<Record<AgingBucket, number>>;
    readonly totalMinor: number;
    readonly invoiceCount: number;
  }[];
}

/** Exactly what a client may see: no cost, no internal note, no member id. */
export interface PortalInvoiceView {
  readonly id: string;
  readonly number: string | null;
  readonly kind: string;
  readonly language: string;
  readonly state: string;
  readonly documentLabel: string;
  /** 52-28: the label in the invoice's language ("Proforma invoice / فاتورة مبدئية" when bi). */
  readonly documentLabelText: string;
  /** 52-28: the "not a tax invoice" line when it went out with the document, else null. */
  readonly taxNotice: string | null;
  readonly taxRegistrationRef: string | null;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly amountDueMinor: number;
  /** 52-13: paid / overdue N days / due in N days / open, on the workspace's calendar. */
  readonly standing: InvoiceStanding;
  readonly notes: string | null;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: number;
    readonly unit: string;
    readonly unitPriceMinor: number;
    readonly taxBp: number;
    readonly netMinor: number;
    readonly grossMinor: number;
  }[];
  readonly payments: readonly {
    readonly paidOn: string;
    readonly amountMinor: number;
    readonly method: string;
  }[];
}

export type PortalInvoiceSummary = Omit<PortalInvoiceView, 'lines' | 'payments' | 'notes'>;

/** Who sent the request, for the timeline. */
export interface RequestMeta {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface SendMeta extends RequestMeta {
  readonly orgSlug: string;
  readonly idempotencyKey?: string | undefined;
  readonly reauthToken?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface ClientInvoicesServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: ClientInvoicesRepository;
  readonly finance: Pick<FinanceRepository, 'profile' | 'organization'>;
  readonly sequences: Pick<DocumentSequenceService, 'nextNumber'>;
  readonly notifications: Pick<NotificationsRepository, 'insertForRecipient'>;
  readonly audit: Pick<AuditService, 'record'>;
  /** 52-12 (R22-a): signs a chain link with the org's ZATCA certificate; absent = never signs. */
  readonly signing?: Pick<EinvoiceSigningService, 'signDocument' | 'certificateFor'> | null;
  /** Counts the org's `client_invoice.sign_failed` audit rows (the third in 24 h raises an event). */
  readonly signingStore?: Pick<OrgSecretsRepository, 'signFailuresSince'>;
  readonly outbox?: Pick<OutboxEventsRepository, 'append'>;
  readonly mailer?: Mailer | null;
  /** 52-10: the workspace's stored branding (name, accent) on the invoice PDF; absent = none. */
  readonly branding?: Pick<OrgBrandingRepository, 'findForOrganization'>;
  readonly webPublicUrl?: string;
  readonly sessionSecret?: string;
  readonly now?: () => Date;
}

const PORTAL_ROLES: ReadonlySet<string> = new Set(['client_admin', 'client_member']);
const PORTAL_HIDDEN_STATES: ReadonlySet<string> = new Set(['draft', 'void']);
const PERSON_LINE_EN = 'Professional services';
const PERSON_LINE_AR = 'خدمات مهنية';

const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);
const forbidden = (code: string): ApiError =>
  new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, code);
const conflict = (message: string, field = 'state'): ApiError =>
  new ApiError(409, 'conflict', message, [{ field, message }]);
const periodLocked = (): ApiError =>
  new ApiError(422, 'validation_failed', 'period_locked', [
    { field: 'issueDate', message: 'period_locked' },
  ]);

function lineView(row: ClientInvoiceLineRow): InvoiceLineView {
  return {
    id: row.id,
    position: row.position,
    sourceType: row.sourceType,
    descriptionEn: row.descriptionEn,
    descriptionAr: row.descriptionAr,
    quantity: row.quantityCenti / 100,
    unit: row.unit,
    unitPriceMinor: Number(row.unitPriceMinor),
    discountBp: row.discountBp,
    taxBp: row.taxBp,
    lineDiscountMinor: Number(row.lineDiscountMinor),
    lineNetMinor: Number(row.lineNetMinor),
    lineTaxMinor: Number(row.lineTaxMinor),
    lineGrossMinor: Number(row.lineGrossMinor),
    groupKey: row.groupKey,
  };
}

function lineInputOf(
  row: Pick<ClientInvoiceLineRow, 'quantityCenti' | 'unitPriceMinor' | 'discountBp' | 'taxBp'>,
): InvoiceLineInput {
  return {
    quantityCenti: row.quantityCenti,
    unitPriceMinor: Number(row.unitPriceMinor),
    discountBp: row.discountBp,
    taxBp: row.taxBp,
  };
}

function dueOf(row: ClientInvoiceRow): number {
  return amountDue({
    totalMinor: Number(row.totalMinor),
    paidMinor: Number(row.paidMinor),
    depositAppliedMinor: Number(row.depositAppliedMinor),
  });
}

export function invoiceSummary(row: ClientInvoiceRow, today: string): InvoiceSummary {
  const open = row.state === 'sent' || row.state === 'partially_paid';
  return {
    id: row.id,
    number: row.number,
    clientOrganizationId: row.clientOrganizationId,
    kind: row.kind,
    state: row.state,
    currency: row.currency,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    totalMinor: Number(row.totalMinor),
    paidMinor: Number(row.paidMinor),
    amountDueMinor: dueOf(row),
    overdue: open && row.dueDate !== null && row.dueDate < today,
  };
}

/** The total in the base currency (for the step-up threshold): ÷ rate, digits adjusted. */
export function toBaseMinor(
  amountMinor: number,
  fxRate: string | null,
  baseCurrency: string,
  currency: string,
): number {
  if (fxRate === null || baseCurrency === currency) return amountMinor;
  const [whole = '0', fraction = ''] = fxRate.split('.');
  const scaled = BigInt(whole + fraction.padEnd(8, '0').slice(0, 8));
  if (scaled <= 0n) return amountMinor;
  const shift = currencyDigits(baseCurrency) - currencyDigits(currency);
  let numerator = BigInt(amountMinor) * 100_000_000n;
  let denominator = scaled;
  if (shift > 0) numerator *= 10n ** BigInt(shift);
  if (shift < 0) denominator *= 10n ** BigInt(-shift);
  return Number(divideHalfUp(numerator, denominator));
}

/** 1 / rate, as DECIMAL(18,8) text. */
function invertRate(rate: string): string | null {
  const [whole = '0', fraction = ''] = rate.split('.');
  const scaled = BigInt(whole + fraction.padEnd(8, '0').slice(0, 8));
  if (scaled <= 0n) return null;
  const inverse = divideHalfUp(10n ** 16n, scaled);
  const text = inverse.toString().padStart(9, '0');
  return `${text.slice(0, -8)}.${text.slice(-8)}`;
}

export class ClientInvoicesService {
  private readonly now: () => Date;
  private readonly mailer: Mailer | null;

  constructor(private readonly options: ClientInvoicesServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.mailer =
      options.mailer === undefined || options.mailer === null
        ? null
        : withTemplateKey(options.mailer, 'client_invoice');
  }

  private get repo(): ClientInvoicesRepository {
    return this.options.repository;
  }

  // ---- reads (finance.view) ----

  async list(
    context: TenantContext,
    principal: Principal,
    query: Record<string, unknown>,
  ): Promise<{ readonly invoices: readonly InvoiceSummary[]; readonly nextCursor: string | null }> {
    this.requireView(principal, context);
    const filter = validateListQuery(query);
    const today = isoDay(this.now());
    return this.options.database.read(context, async (r) => {
      const rows = await this.repo.listInvoices(r, context.organizationId, {
        ...filter,
        limit: LIST_PAGE + 1,
      });
      const page = rows.slice(0, LIST_PAGE);
      return {
        invoices: page.map((row) => invoiceSummary(row, today)),
        nextCursor: rows.length > LIST_PAGE ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }

  async get(context: TenantContext, principal: Principal, id: string): Promise<InvoiceView> {
    this.requireView(principal, context);
    return this.options.database.read(context, async (r) => {
      const row = await this.repo.findInvoice(r, context.organizationId, id);
      if (row === null) throw notFound();
      return this.view(r, context.organizationId, row);
    });
  }

  async aging(context: TenantContext, principal: Principal): Promise<AgingView> {
    this.requireView(principal, context);
    const today = isoDay(this.now());
    return this.options.database.read(context, async (r) => {
      const rows = await this.repo.openInvoices(r, context.organizationId);
      const byCurrency = new Map<
        string,
        { buckets: Record<AgingBucket, number>; total: number; count: number }
      >();
      for (const row of rows) {
        const due = amountDue({
          totalMinor: Number(row.totalMinor),
          paidMinor: Number(row.paidMinor),
          depositAppliedMinor: Number(row.depositAppliedMinor),
        });
        const slot = byCurrency.get(row.currency) ?? {
          buckets: { '0_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 },
          total: 0,
          count: 0,
        };
        slot.buckets[agingBucket(row.dueDate ?? today, today)] += due;
        slot.total += due;
        slot.count += 1;
        byCurrency.set(row.currency, slot);
      }
      return {
        asOf: today,
        currencies: [...byCurrency.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, slot]) => ({
            currency,
            buckets: slot.buckets,
            totalMinor: slot.total,
            invoiceCount: slot.count,
          })),
      };
    });
  }

  /**
   * 52-12 — the e-invoice of an issued invoice: the UBL XML rebuilt from the stored row, lines and
   * snapshots, the chain facts, and whether the rebuilt hash equals the stored one (the tamper
   * check). A draft is a 409 `not_issued`; an org without a structured regime (and an invoice
   * outside the chain) a 404 `einvoice_not_applicable`. Same authorization as the read.
   */
  async einvoice(context: TenantContext, principal: Principal, id: string): Promise<EinvoiceView> {
    this.requireView(principal, context);
    const org = context.organizationId;
    return this.options.database.read(context, async (r) => {
      const row = await this.repo.findInvoice(r, org, id);
      if (row === null) throw notFound();
      if (row.state === 'draft') throw conflict('not_issued');
      const chained = row.zatcaIcv !== null && row.zatcaIcv !== undefined;
      const regime = chained ? 'zatca' : ublProfileOf((await this.profile(r, org)).einvoiceRegime);
      if (regime === null) {
        throw new ApiError(404, 'not_found', 'einvoice_not_applicable', [
          { field: 'regime', message: 'einvoice_not_applicable' },
        ]);
      }
      const doc = invoiceDocument(row);
      const xml = einvoiceXml(
        doc,
        invoiceUblLines(await this.repo.lines(r, org, id), row.language),
        regime,
        chained ? { icv: Number(row.zatcaIcv), pih: row.zatcaPih ?? '' } : null,
      );
      const stored = row.zatcaXmlHash ?? null;
      const signature = row.zatcaSignature ?? null;
      const fingerprint = row.zatcaCertFingerprint ?? null;
      let qr = regime === 'zatca' ? qrFor(doc) : null;
      let signatureValid: boolean | null = null;
      if (row.zatcaStatus === 'signed' && signature !== null && fingerprint !== null) {
        // 52-12 (R22-a): the certificate the document was signed with (active or rotated) gives
        // the public key and CA signature of tags 8–9; re-verifying is the second tamper check.
        const cert = (await this.options.signing?.certificateFor(r, org, fingerprint)) ?? null;
        signatureValid = cert !== null && verifyXmlSignature(xml, signature, cert.publicKeyPem);
        if (cert !== null && stored !== null) {
          qr = phase2Qr(phase1Of(doc), {
            xmlHashHex: stored,
            signatureB64: signature,
            publicKeyDer: Uint8Array.from(Buffer.from(cert.publicKeyDerB64, 'base64')),
            certSignatureDer: Uint8Array.from(Buffer.from(cert.certSignatureB64, 'base64')),
          });
        }
      }
      return {
        invoiceId: row.id,
        number: row.number ?? '',
        regime,
        status: row.zatcaStatus ?? 'not_applicable',
        icv: chained ? Number(row.zatcaIcv) : null,
        pih: row.zatcaPih ?? null,
        xmlHash: stored,
        hashMatches: stored === null ? null : xmlHash(xml) === stored,
        qr,
        xml,
        signature,
        certFingerprint: fingerprint,
        signatureValid,
      };
    });
  }

  /** The HTML print view (plain-text escaped; bilingual when 'bi'). */
  async print(
    context: TenantContext,
    principal: Principal,
    id: string,
    lang: unknown,
  ): Promise<string> {
    const facts = await this.printFacts(context, principal, id);
    return renderPrint(facts.view, documentLanguage(lang, facts.view.language), facts);
  }

  /**
   * 52-10 — the invoice as a PDF, drawn by the shared record PDF writer from the same stored
   * document and parties as the print view, with the workspace's branding. Same authorization as
   * the read (`finance.view`, this organization's invoice, else 404).
   */
  async pdf(
    context: TenantContext,
    principal: Principal,
    id: string,
    lang: unknown,
  ): Promise<RecordPdfFile> {
    const facts = await this.printFacts(context, principal, id);
    return this.documentPdf(facts, documentLanguage(lang, facts.view.language));
  }

  /** What the team's print and PDF show: the invoice, its parties and whether the notice prints. */
  private async printFacts(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<PrintFacts> {
    const view = await this.get(context, principal, id);
    const org = context.organizationId;
    return this.options.database.read(context, async (r) => {
      const row = await this.repo.findInvoice(r, org, id);
      if (row === null) throw notFound();
      const { parties, country } = await this.printParties(r, org, row, view.state);
      // A sent document shows the notice it went out with; a draft previews today's rule.
      const notice =
        view.state === 'draft' ? taxNoticeRequired(country, view.documentLabel) : noticeOf(view);
      return { view, notice, parties, country, brand: await this.brand(r, context) };
    });
  }

  /** The workspace's stored branding (none when the module is wired without it). */
  private async brand(r: TenantQueryRunner, context: TenantContext): Promise<DocumentBrand> {
    return documentBrand((await this.options.branding?.findForOrganization(r, context)) ?? null);
  }

  /**
   * INVMAIL. The issued invoice as a mail attachment, built from the stored document in the
   * document's own language. Never for a draft or a void invoice; `null` when it cannot be built,
   * because the mail still carries the portal link.
   */
  private async pdfAttachment(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<MailAttachment | null> {
    try {
      const facts = await this.printFacts(context, principal, id);
      if (facts.view.state === 'draft' || facts.view.state === 'void') return null;
      const file = await this.documentPdf(facts, documentLanguage(undefined, facts.view.language));
      return { filename: file.fileName, contentType: 'application/pdf', content: file.bytes };
    } catch {
      return null;
    }
  }

  private documentPdf(facts: PrintFacts, language: 'en' | 'ar' | 'bi'): Promise<RecordPdfFile> {
    return renderDocumentPdf(
      'invoice',
      facts.view.number,
      invoicePdfDocument(facts.view, language, facts),
    );
  }

  /**
   * B5: a sent document prints the parties it went out with; a draft previews today's profile
   * and the client's billing record.
   */
  private async printParties(
    r: TenantQueryRunner,
    org: string,
    row: ClientInvoiceRow,
    state: string,
  ): Promise<{ readonly parties: PrintParties; readonly country: string }> {
    const profile = await this.profile(r, org);
    if (state !== 'draft' && row.sellerSnapshotJson !== null) {
      const seller = sellerFromSnapshot(row.sellerSnapshotJson);
      return {
        parties: printPartiesFromSnapshots(row.sellerSnapshotJson, row.buyerSnapshotJson),
        country: seller.country ?? profile.country,
      };
    }
    const client = await this.repo.clientBilling(r, org, row.clientOrganizationId);
    return { parties: printPartiesFromRecords(profile, client), country: profile.country };
  }

  // ---- writes (finance.manage) ----

  async create(context: TenantContext, principal: Principal, body: unknown): Promise<InvoiceView> {
    this.requireManage(principal, context);
    const input = validateCreate(body);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const client = await this.repo.clientBilling(tx, org, input.clientOrganizationId);
      if (client === null) throw notFound();
      if (
        input.projectId !== null &&
        !(await this.repo.projectLinkedToClient(
          tx,
          org,
          input.clientOrganizationId,
          input.projectId,
        ))
      ) {
        throw invalid('projectId', 'project_not_linked_to_client');
      }
      const profile = await this.profile(tx, org);
      const currency = input.currency ?? client.defaultCurrency ?? profile.baseCurrency;
      const fxRate = await this.rateFor(
        tx,
        org,
        profile.baseCurrency,
        currency,
        input.issueDate ?? isoDay(at),
      );
      if (input.issueDate !== null) await this.refuseLocked(tx, org, input.issueDate);
      const terms = client.paymentTermsDays ?? profile.paymentTermsDays;
      const row: ClientInvoiceRow = {
        id: uuidv7(),
        organizationId: org,
        clientOrganizationId: input.clientOrganizationId,
        projectId: input.projectId,
        retainerPeriodId: null,
        quoteId: null,
        number: null,
        kind: input.kind,
        language: input.language,
        state: 'draft',
        documentLabel: defaultLabelFor(profile.country, profile.vatRegistrationStatus),
        issueDate: input.issueDate,
        dueDate: input.issueDate === null ? null : addDays(input.issueDate, terms),
        supplyDate: null,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        currency,
        baseCurrency: profile.baseCurrency,
        fxRate,
        subtotalMinor: 0,
        discountMinor: 0,
        taxMinor: 0,
        totalMinor: 0,
        paidMinor: 0,
        depositAppliedMinor: 0,
        poNumber: input.poNumber,
        notesText: input.notesText,
        internalNote: input.internalNote,
        termsText: input.termsText ?? profile.bankDetailsText,
        buyerSnapshotJson: null,
        sellerSnapshotJson: null,
        contentHash: null,
        sendKeyHash: null,
        pdfFileAssetId: null,
        pdfFileVersionId: null,
        xmlFileAssetId: null,
        sentAt: null,
        sentTo: null,
        viewedAt: null,
        paidAt: null,
        voidedAt: null,
        voidReason: null,
        exportedAt: null,
        exportTarget: null,
        taxRegistrationRef: null,
        taxRegisteredAt: null,
        taxNoticeShown: false,
        zatcaIcv: null,
        zatcaPih: null,
        zatcaXmlHash: null,
        zatcaStatus: 'not_applicable',
        zatcaSignature: null,
        zatcaCertFingerprint: null,
        createdBy: context.userId,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      await this.repo.insertInvoice(tx, row);
      await this.event(tx, context, row.id, 'created', 'member', null, {}, at);
      await this.audited(tx, context, 'client_invoice.created', row.id, {
        client_organization_id: row.clientOrganizationId,
        kind: row.kind,
        language: row.language,
        currency: row.currency,
        document_label: row.documentLabel,
      });
      return this.view(tx, org, row);
    });
  }

  async update(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<InvoiceView> {
    this.requireManage(principal, context);
    const patch = validatePatch(body);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.draft(tx, org, id);
      if (row.version !== patch.expectedVersion)
        throw conflict(MESSAGES.conflict, 'expectedVersion');
      const change: InvoiceChange = {};
      for (const key of [
        'kind',
        'language',
        'issueDate',
        'dueDate',
        'supplyDate',
        'poNumber',
        'notesText',
        'internalNote',
        'termsText',
        'depositAppliedMinor',
      ] as const) {
        if (patch[key] !== undefined) Object.assign(change, { [key]: patch[key] });
      }
      if (patch.issueDate !== undefined) {
        await this.refuseLocked(tx, org, patch.issueDate);
        if (patch.dueDate === undefined) {
          const client = await this.repo.clientBilling(tx, org, row.clientOrganizationId);
          const profile = await this.profile(tx, org);
          change.dueDate = addDays(
            patch.issueDate,
            client?.paymentTermsDays ?? profile.paymentTermsDays,
          );
        }
      }
      if (patch.lines !== undefined) await this.replaceLines(tx, org, row.id, patch.lines, at);
      const totals = await this.totals(tx, org, row.id);
      const next: ClientInvoiceRow = {
        ...row,
        ...change,
        ...totals,
        version: row.version + 1,
        updatedAt: at,
      };
      if (next.depositAppliedMinor > next.totalMinor) {
        throw invalid('depositAppliedMinor', 'must not exceed the invoice total');
      }
      await this.repo.updateInvoice(tx, org, id, {
        ...change,
        ...totals,
        version: next.version,
        updatedAt: at,
      });
      return this.view(tx, org, next);
    });
  }

  /** Idempotent on a draft: the pulled kinds' lines are replaced; manual and other kinds kept. */
  async pull(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<PullResult> {
    this.requireManage(principal, context);
    const input = validatePull(body);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.draft(tx, org, id);
      const profile = await this.profile(tx, org);
      const convert = (amountBaseMinor: number): number =>
        convertMinor(amountBaseMinor, row.fxRate, row.baseCurrency, row.currency);
      // B2: only the kinds this pull asks for are replaced; every other line stays on the draft.
      const replaced = pulledSourceTypes(input);
      const existing = await this.repo.lines(tx, org, id);
      await this.repo.deleteLines(
        tx,
        org,
        id,
        existing.filter((l) => replaced.has(l.sourceType)).map((l) => l.id),
      );
      const kept = existing.filter((l) => !replaced.has(l.sourceType));
      const pulled: PulledLine[] = [];
      let waiting = 0;
      let unpriced = 0;
      let retainerPeriodId: string | null = input.retainer ? null : (row.retainerPeriodId ?? null);
      let quoteId: string | null = row.quoteId;
      const client = row.clientOrganizationId;
      if (input.time !== null) {
        const rows = await this.repo.approvedTime(
          tx,
          org,
          client,
          input.periodStart,
          input.periodEnd,
        );
        const priced = timeLines(rows, {
          grouping: input.time,
          taxBp: profile.defaultTaxRateBp,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          convert,
        });
        pulled.push(...priced.lines);
        unpriced = priced.unpricedMinutes;
        waiting = await this.repo.waitingMinutes(
          tx,
          org,
          client,
          input.periodStart,
          input.periodEnd,
        );
      }
      if (input.expenses) {
        const projects = await this.repo.clientProjectIds(tx, org, client);
        const rows = await this.repo.approvedExpenses(
          tx,
          org,
          client,
          projects,
          input.periodStart,
          input.periodEnd,
        );
        pulled.push(...expenseLines(rows, convert));
      }
      if (input.retainer) {
        const period = await this.repo.retainerPeriod(
          tx,
          org,
          client,
          input.periodStart,
          input.periodEnd,
        );
        if (period !== null) {
          pulled.push(retainerLine(period, profile.defaultTaxRateBp, convert));
          retainerPeriodId = period.periodId;
        }
      }
      if (input.quote !== null) {
        const quote = await this.repo.acceptedQuote(tx, org, client, input.quote.quoteId);
        if (quote === null) throw invalid('include.quote.quoteId', 'quote_not_accepted_for_client');
        if (quote.currency !== row.currency) {
          throw invalid('include.quote.quoteId', 'quote_currency_differs_from_invoice');
        }
        pulled.push(...quoteLines(quote, input.quote.depositBp));
        quoteId = input.quote.quoteId;
      }
      if (kept.length + pulled.length > MAX_INVOICE_LINES) {
        throw invalid('include', `an invoice holds at most ${String(MAX_INVOICE_LINES)} lines`);
      }
      const start = kept.reduce((max, l) => Math.max(max, l.position + 1), 0);
      await this.repo.insertLines(
        tx,
        pulled.map((line, index) => this.lineRow(org, id, start + index, line, at)),
      );
      const totals = await this.totals(tx, org, id);
      const change: InvoiceChange = {
        ...totals,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        retainerPeriodId,
        quoteId,
        version: row.version + 1,
        updatedAt: at,
      };
      await this.repo.updateInvoice(tx, org, id, change);
      return {
        invoice: await this.view(tx, org, { ...row, ...change } as ClientInvoiceRow),
        waiting: { minutes: waiting },
        unpriced: { minutes: unpriced },
      };
    });
  }

  /**
   * ONE transaction: number from `org_document_sequences`, buyer/seller snapshots, the canonical
   * hash, the source links, state `sent` and the `sent` event. The same `Idempotency-Key` answers
   * the same response; a second sender without it waits on the row lock and gets a 409. The mail
   * (EN/AR, transactional lane, the portal link) leaves after the commit.
   */
  async send(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
    meta: SendMeta,
    mail = true,
  ): Promise<InvoiceView> {
    this.requireManage(principal, context);
    const input = mail
      ? validateSend(body)
      : { to: [] as string[], message: null, attachPdf: false };
    const keyHash = idempotencyKeyHash(meta.idempotencyKey);
    const org = context.organizationId;
    const at = this.now();
    const outcome = await this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.findInvoice(tx, org, id, true);
      if (row === null) throw notFound();
      if (row.state !== 'draft') {
        if (keyHash !== null && row.sendKeyHash === keyHash) {
          return { view: await this.view(tx, org, row), fresh: false, country: null };
        }
        throw conflict('already_sent');
      }
      const lines = await this.repo.lines(tx, org, id);
      if (lines.length === 0) throw invalid('lines', 'an invoice needs at least one line');
      const totals = invoiceTotals(lines.map(lineInputOf));
      const threshold = Number(
        (await this.repo.setting(tx, org, STEP_UP_SEND_SETTING_KEY)) ?? DEFAULT_STEP_UP_SEND_MINOR,
      );
      const baseTotal = toBaseMinor(totals.totalMinor, row.fxRate, row.baseCurrency, row.currency);
      if (Number.isFinite(threshold) && baseTotal > threshold && !this.stepUpFresh(context, meta)) {
        throw new ApiError(
          403,
          'reauthentication_required',
          'Confirm your password to send an invoice of this size.',
          undefined,
          'client_invoice.send_step_up',
        );
      }
      const issueDate = row.issueDate ?? isoDay(at);
      await this.refuseLocked(tx, org, issueDate);
      const client = await this.repo.clientBilling(tx, org, row.clientOrganizationId);
      if (client === null) throw notFound();
      const profile = await this.profile(tx, org);
      const dueDate =
        row.dueDate ?? addDays(issueDate, client.paymentTermsDays ?? profile.paymentTermsDays);
      if (row.depositAppliedMinor > totals.totalMinor) {
        throw invalid('depositAppliedMinor', 'must not exceed the invoice total');
      }
      const issued = await this.options.sequences.nextNumber(tx, org, 'invoice', at);
      for (const line of lines) await this.link(tx, org, row.id, line, at);
      const sent: ClientInvoiceRow = {
        ...row,
        number: issued.number,
        state: 'sent',
        issueDate,
        dueDate,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        buyerSnapshotJson: JSON.stringify({
          name: client.name,
          legalNameEn: client.legalNameEn,
          legalNameAr: client.legalNameAr,
          taxRegistrationNo: client.taxRegistrationNo,
          addressEn: client.billingAddressEn,
          addressAr: client.billingAddressAr,
          email: client.billingEmail,
        }),
        sellerSnapshotJson: JSON.stringify({
          legalNameEn: profile.legalNameEn,
          legalNameAr: profile.legalNameAr,
          taxRegistrationNo: profile.taxRegistrationNo,
          addressEn: profile.addressEn,
          addressAr: profile.addressAr,
          country: profile.country,
          bankDetails: profile.bankDetailsText,
          // 52-12: the structured address the e-invoice XML is rebuilt from (regime orgs only).
          ...(ublProfileOf(profile.einvoiceRegime) === null
            ? {}
            : { address: profile.addressJson }),
        }),
        sendKeyHash: keyHash,
        sentAt: at,
        sentTo: input.to.join(', ').slice(0, 254) || null,
        taxNoticeShown: taxNoticeRequired(profile.country, row.documentLabel),
        version: row.version + 1,
        updatedAt: at,
      };
      sent.contentHash = invoiceContentHash(sent, lines);
      if (profile.einvoiceRegime === 'zatca') {
        // 52-12: the ICV is assigned here, with the number, never on a draft. Gapless: the
        // invoice number already holds its sequence row lock (`DocumentSequenceService`), and
        // `lockChain` serialises invoices with credit notes, which take another sequence.
        await this.repo.lockChain(tx, org);
        const head = await this.repo.chainHead(tx, org);
        const link = chainLink(head, (position) =>
          einvoiceXml(
            invoiceDocument(sent),
            invoiceUblLines(lines, sent.language),
            'zatca',
            position,
          ),
        );
        sent.zatcaIcv = link.icv;
        sent.zatcaPih = link.pih;
        sent.zatcaXmlHash = link.xmlHash;
        sent.zatcaStatus = 'ready';
        // 52-12 (R22-a): signed inside the same transaction; a failure never blocks the send.
        const signed = await this.signLink(tx, context, id, 'invoice', id, link.xml);
        if (signed !== null) {
          sent.zatcaSignature = signed.signature;
          sent.zatcaCertFingerprint = signed.fingerprint;
          sent.zatcaStatus = 'signed';
        }
      }
      await this.repo.updateInvoice(tx, org, id, {
        zatcaIcv: sent.zatcaIcv ?? null,
        zatcaPih: sent.zatcaPih ?? null,
        zatcaXmlHash: sent.zatcaXmlHash ?? null,
        zatcaStatus: sent.zatcaStatus ?? 'not_applicable',
        zatcaSignature: sent.zatcaSignature ?? null,
        zatcaCertFingerprint: sent.zatcaCertFingerprint ?? null,
        number: sent.number,
        state: sent.state,
        issueDate,
        dueDate,
        subtotalMinor: sent.subtotalMinor,
        discountMinor: sent.discountMinor,
        taxMinor: sent.taxMinor,
        totalMinor: sent.totalMinor,
        buyerSnapshotJson: sent.buyerSnapshotJson,
        sellerSnapshotJson: sent.sellerSnapshotJson,
        contentHash: sent.contentHash,
        sendKeyHash: keyHash,
        sentAt: at,
        sentTo: sent.sentTo,
        taxNoticeShown: sent.taxNoticeShown,
        version: sent.version,
        updatedAt: at,
      });
      await this.event(
        tx,
        context,
        id,
        'sent',
        'member',
        meta,
        {
          number: issued.number,
          recipients: input.to.length,
          mail,
        },
        at,
      );
      await this.audited(tx, context, 'client_invoice.sent', id, {
        number: issued.number,
        total_minor: sent.totalMinor,
        currency: sent.currency,
        recipient_count: input.to.length,
        mode: mail ? 'mail' : 'mark_sent',
      });
      if (mail) {
        for (const recipientUserId of await this.repo.clientAdminUserIds(
          tx,
          org,
          row.clientOrganizationId,
        )) {
          await this.options.notifications.insertForRecipient(tx, context, {
            recipientUserId,
            type: 'client_invoice.sent',
            objectType: 'client_invoice',
            objectId: id,
            dedupeKey: `client_invoice.sent:${id}`,
          });
        }
      }
      return {
        view: await this.view(tx, org, sent),
        fresh: true,
        country: sellerFromSnapshot(sent.sellerSnapshotJson).country,
      };
    });
    if (outcome.fresh && mail) {
      const attachment = input.attachPdf ? await this.pdfAttachment(context, principal, id) : null;
      await this.deliver(
        input.to,
        outcome.view,
        meta.orgSlug,
        'invoice',
        input.message,
        outcome.country,
        attachment,
      );
    }
    return outcome.view;
  }

  /**
   * 52-28 — a draft's document label. `tax_invoice` passes only the country rule (KSA/EG: VAT
   * registered and a registration reference recorded), else 422 `tax_invoice_requires_registration`.
   * An issued invoice is a 409 `not_draft`; its label moves only through the tax-registration route.
   */
  async setLabel(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
    meta: RequestMeta = {},
  ): Promise<InvoiceView> {
    this.requireManage(principal, context);
    const label = validateLabel(body);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.draft(tx, org, id);
      if (row.documentLabel === label) return this.view(tx, org, row);
      const profile = await this.profile(tx, org);
      const check = canUseLabel({
        country: profile.country,
        vatStatus: profile.vatRegistrationStatus,
        label,
        taxRegistrationRef: row.taxRegistrationRef,
      });
      if (!check.ok) {
        throw new ApiError(422, 'validation_failed', check.reason, [
          { field: 'documentLabel', message: check.reason },
        ]);
      }
      const change: InvoiceChange = {
        documentLabel: label,
        version: row.version + 1,
        updatedAt: at,
      };
      await this.repo.updateInvoice(tx, org, id, change);
      await this.event(
        tx,
        context,
        id,
        'label_changed',
        'member',
        meta,
        { before: row.documentLabel, after: label },
        at,
      );
      await this.audited(
        tx,
        context,
        'client_invoice.label_changed',
        id,
        { before: row.documentLabel, after: label },
        [{ field: 'documentLabel', before: row.documentLabel, after: label }],
      );
      return this.view(tx, org, { ...row, ...change } as ClientInvoiceRow);
    });
  }

  /**
   * 52-28 — record the tax registration reference (any state but void; post-send allowed). The
   * shape is checked per regime; a proforma/commercial label becomes `tax_invoice` when the rule
   * then passes. Idempotent: the same ref again answers unchanged, a different one is a 409.
   * `tax_notice_shown` keeps what went out with the document.
   */
  async recordTaxRegistration(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
    meta: RequestMeta = {},
  ): Promise<InvoiceView> {
    this.requireManage(principal, context);
    const at = this.now();
    const input = validateTaxRegistration(body, at);
    const org = context.organizationId;
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.findInvoice(tx, org, id, true);
      if (row === null) throw notFound();
      if (row.state === 'void') throw conflict('not_registrable:void');
      if (row.taxRegistrationRef !== null) {
        if (row.taxRegistrationRef === input.ref) return this.view(tx, org, row);
        throw conflict('already_registered', 'ref');
      }
      const profile = await this.profile(tx, org);
      const regime = resolvedRegime(profile.country, profile.einvoiceRegime);
      if (!isValidTaxRef(regime, input.ref)) throw invalid('ref', `invalid_tax_ref_for_${regime}`);
      const upgrade =
        (row.documentLabel === 'proforma' || row.documentLabel === 'commercial') &&
        canUseLabel({
          country: profile.country,
          vatStatus: profile.vatRegistrationStatus,
          label: 'tax_invoice',
          taxRegistrationRef: input.ref,
        }).ok;
      const label = upgrade ? 'tax_invoice' : row.documentLabel;
      const change: InvoiceChange = {
        taxRegistrationRef: input.ref,
        taxRegisteredAt: input.registeredAt,
        documentLabel: label,
        version: row.version + 1,
        updatedAt: at,
      };
      await this.repo.updateInvoice(tx, org, id, change);
      await this.event(
        tx,
        context,
        id,
        'tax_registered',
        'member',
        meta,
        { regime, label_before: row.documentLabel, label_after: label },
        at,
      );
      await this.audited(
        tx,
        context,
        'client_invoice.tax_registered',
        id,
        {
          regime,
          registered_on: isoDay(input.registeredAt),
          label_before: row.documentLabel,
          label_after: label,
        },
        [{ field: 'documentLabel', before: row.documentLabel, after: label }],
      );
      return this.view(tx, org, { ...row, ...change } as ClientInvoiceRow);
    });
  }

  async recordPayment(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
    meta: RequestMeta = {},
  ): Promise<InvoiceView> {
    this.requireManage(principal, context);
    const input = validatePayment(body);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.findInvoice(tx, org, id, true);
      if (row === null) throw notFound();
      const allow = (await this.repo.setting(tx, org, ALLOW_OVERPAYMENT_SETTING_KEY)) === 'on';
      const outcome = applyPayment(
        {
          state: row.state,
          totalMinor: Number(row.totalMinor),
          paidMinor: Number(row.paidMinor),
          depositAppliedMinor: Number(row.depositAppliedMinor),
        },
        input.amountMinor,
        allow,
      );
      if (!outcome.ok) {
        if (outcome.error === 'invalid_state') throw conflict(`not_payable:${row.state}`);
        throw invalid('amountMinor', outcome.error);
      }
      const payment: ClientInvoicePaymentRow = {
        id: uuidv7(),
        organizationId: org,
        invoiceId: id,
        paidOn: input.paidOn,
        amountMinor: input.amountMinor,
        currency: row.currency,
        method: input.method,
        reference: input.reference,
        note: input.note,
        recordedBy: context.userId,
        createdAt: at,
      };
      await this.repo.insertPayment(tx, payment);
      const change: InvoiceChange = {
        state: outcome.state,
        paidMinor: outcome.paidMinor,
        paidAt: outcome.state === 'paid' ? at : row.paidAt,
        version: row.version + 1,
        updatedAt: at,
      };
      await this.repo.updateInvoice(tx, org, id, change);
      await this.event(
        tx,
        context,
        id,
        'payment_recorded',
        'member',
        meta,
        {
          amount_minor: input.amountMinor,
          method: input.method,
        },
        at,
      );
      await this.audited(tx, context, 'client_invoice.payment_recorded', id, {
        amount_minor: input.amountMinor,
        method: input.method,
        state: outcome.state,
      });
      return this.view(tx, org, { ...row, ...change } as ClientInvoiceRow);
    });
  }

  /** Draft only; whatever its lines hold is released. */
  async voidInvoice(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
    meta: RequestMeta = {},
  ): Promise<InvoiceView> {
    this.requireManage(principal, context);
    const reason = validateReason(body);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.findInvoice(tx, org, id, true);
      if (row === null) throw notFound();
      const next = nextInvoiceState(row.state, 'void');
      if (next === null) throw conflict(`invalid_transition:${row.state}->void`);
      const lines = await this.repo.lines(tx, org, id);
      await this.repo.releaseLinks(
        tx,
        org,
        id,
        lines.map((l) => l.id),
      );
      // 52-12: the chain is untouched — only a draft voids, and a draft never holds an ICV (it is
      // assigned at send); an issued invoice is corrected by a credit note, its own chain link.
      const change: InvoiceChange = {
        state: next,
        voidedAt: at,
        voidReason: reason,
        version: row.version + 1,
        updatedAt: at,
      };
      await this.repo.updateInvoice(tx, org, id, change);
      await this.event(tx, context, id, 'voided', 'member', meta, {}, at);
      await this.audited(tx, context, 'client_invoice.voided', id, { previous_state: row.state });
      return this.view(tx, org, { ...row, ...change } as ClientInvoiceRow);
    });
  }

  async creditNote(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
    meta: RequestMeta = {},
  ): Promise<InvoiceView> {
    this.requireManage(principal, context);
    const input = validateCreditNote(body);
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.findInvoice(tx, org, id, true);
      if (row === null) throw notFound();
      if (!isCreditable(row.state)) throw conflict(`not_creditable:${row.state}`);
      const sources: readonly LineInput[] =
        input.lines ??
        (await this.repo.lines(tx, org, id)).map((l) => ({
          id: null,
          descriptionEn: l.descriptionEn,
          descriptionAr: l.descriptionAr,
          quantityCenti: 100,
          unit: 'item',
          // The line as issued: its discounted net, at its tax rate.
          unitPriceMinor: Number(l.lineNetMinor),
          discountBp: 0,
          taxBp: l.taxBp,
        }));
      const already = (await this.repo.creditNotes(tx, org, id)).reduce(
        (sum, note) => sum + Number(note.totalMinor),
        0,
      );
      let totals;
      try {
        totals = creditNoteTotals(sources.map(lineInputOf), Number(row.totalMinor), already);
      } catch (error) {
        if (error instanceof MoneyError) throw invalid('lines', 'credit_exceeds_invoice_total');
        throw error;
      }
      const issued = await this.options.sequences.nextNumber(tx, org, 'credit_note', at);
      const noteId = uuidv7();
      const noteLines: ClientCreditNoteLineRow[] = sources.map((line, position) => ({
        id: uuidv7(),
        organizationId: org,
        creditNoteId: noteId,
        position,
        descriptionEn: line.descriptionEn,
        descriptionAr: line.descriptionAr,
        quantityCenti: line.quantityCenti,
        unit: line.unit,
        unitPriceMinor: line.unitPriceMinor,
        taxBp: line.taxBp,
        lineNetMinor: totals.lines[position]!.lineNetMinor,
        lineTaxMinor: totals.lines[position]!.lineTaxMinor,
        lineGrossMinor: totals.lines[position]!.lineGrossMinor,
        createdAt: at,
      }));
      const note: ClientCreditNoteRow = {
        id: noteId,
        organizationId: org,
        invoiceId: id,
        number: issued.number,
        reason: input.reason,
        subtotalMinor: totals.subtotalMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        contentHash: createHash('sha256')
          .update(
            JSON.stringify([
              issued.number,
              row.number,
              input.reason,
              noteLines.map((l) => [
                l.position,
                l.descriptionEn,
                l.descriptionAr,
                l.quantityCenti,
                l.unitPriceMinor,
                l.taxBp,
                l.lineNetMinor,
                l.lineTaxMinor,
              ]),
              totals.totalMinor,
            ]),
            'utf8',
          )
          .digest('hex'),
        pdfFileAssetId: null,
        xmlFileAssetId: null,
        zatcaIcv: null,
        zatcaPih: null,
        zatcaXmlHash: null,
        zatcaStatus: 'not_applicable',
        zatcaSignature: null,
        zatcaCertFingerprint: null,
        issuedAt: at,
        createdBy: context.userId,
        createdAt: at,
        exportedAt: null,
        exportTarget: null,
      };
      if ((await this.profile(tx, org)).einvoiceRegime === 'zatca') {
        // 52-12: a credit note is a link of the same chain (one counter with the invoices), its
        // seller as the corrected invoice froze it; assigned with its number, under `lockChain`.
        await this.repo.lockChain(tx, org);
        const doc: EinvoiceDocument = {
          id: noteId,
          number: issued.number,
          kind: 'credit_note',
          issuedAt: at,
          issueDate: isoDay(at),
          supplyDate: row.supplyDate ?? row.issueDate,
          currency: row.currency,
          buyerSnapshotJson: row.buyerSnapshotJson,
          sellerSnapshotJson: row.sellerSnapshotJson,
          subtotalMinor: totals.subtotalMinor,
          discountMinor: 0,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          billingReference: row.number,
          creditReason: input.reason,
        };
        const link = chainLink(await this.repo.chainHead(tx, org), (position) =>
          einvoiceXml(doc, creditNoteUblLines(noteLines, row.language), 'zatca', position),
        );
        note.zatcaIcv = link.icv;
        note.zatcaPih = link.pih;
        note.zatcaXmlHash = link.xmlHash;
        note.zatcaStatus = 'ready';
        const signed = await this.signLink(tx, context, id, 'credit_note', noteId, link.xml);
        if (signed !== null) {
          note.zatcaSignature = signed.signature;
          note.zatcaCertFingerprint = signed.fingerprint;
          note.zatcaStatus = 'signed';
        }
      }
      await this.repo.insertCreditNote(tx, note, noteLines);
      const full = already + totals.totalMinor >= Number(row.totalMinor);
      const change: InvoiceChange = { version: row.version + 1, updatedAt: at };
      if (full) change.state = nextInvoiceState(row.state, 'credit_full') ?? row.state;
      await this.repo.updateInvoice(tx, org, id, change);
      await this.event(
        tx,
        context,
        id,
        'credited',
        'member',
        meta,
        {
          credit_note: issued.number,
          total_minor: totals.totalMinor,
          full,
        },
        at,
      );
      await this.audited(tx, context, 'client_invoice.credited', id, {
        // Not `credit_note_number`: `note` is a refused audit key segment (content, not a fact),
        // and the refusal turned every credit note into a 500.
        credit_number: issued.number,
        total_minor: totals.totalMinor,
        full,
      });
      return this.view(tx, org, { ...row, ...change } as ClientInvoiceRow);
    });
  }

  /** A templated EN/AR reminder; one per invoice per day. */
  async reminder(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
    meta: SendMeta,
  ): Promise<{ readonly sent: true; readonly recipients: number }> {
    this.requireManage(principal, context);
    const org = context.organizationId;
    const at = this.now();
    const raw = (body ?? {}) as Record<string, unknown>;
    const view = await this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.findInvoice(tx, org, id, true);
      if (row === null) throw notFound();
      if (row.state !== 'sent' && row.state !== 'partially_paid') {
        throw conflict(`not_open:${row.state}`);
      }
      const since = new Date(`${isoDay(at)}T00:00:00.000Z`);
      if (await this.repo.hasEventSince(tx, org, id, 'reminder_sent', since)) {
        throw new ApiError(
          429,
          'rate_limited',
          'A reminder for this invoice was already sent today.',
        );
      }
      let to: string[];
      if (Array.isArray(raw['to']) && raw['to'].length > 0) {
        to = validateSend({ to: raw['to'] }).to as string[];
      } else {
        const client = await this.repo.clientBilling(tx, org, row.clientOrganizationId);
        if (client?.billingEmail === null || client?.billingEmail === undefined) {
          throw invalid('to', 'the client has no billing e-mail; name a recipient');
        }
        to = [validateEmail(client.billingEmail, 'to')];
      }
      await this.event(
        tx,
        context,
        id,
        'reminder_sent',
        'member',
        meta,
        { recipients: to.length },
        at,
      );
      await this.audited(tx, context, 'client_invoice.reminder_sent', id, {
        recipient_count: to.length,
      });
      return {
        view: await this.view(tx, org, row),
        to,
        country: sellerFromSnapshot(row.sellerSnapshotJson).country,
      };
    });
    await this.deliver(view.to, view.view, meta.orgSlug, 'reminder', null, view.country);
    return { sent: true, recipients: view.to.length };
  }

  // ---- portal (client_projection.read) ----

  async portalList(
    context: TenantContext,
    principal: Principal,
  ): Promise<{ readonly invoices: readonly PortalInvoiceSummary[] }> {
    const clientOrg = this.portalClient(principal, null);
    return this.options.database.read(context, async (r) => {
      const today = await this.workspaceToday(r, context.organizationId);
      const rows = await this.repo.listInvoices(r, context.organizationId, {
        state: null,
        clientOrganizationId: clientOrg,
        cursor: null,
        excludeDrafts: true,
        limit: 200,
      });
      return {
        invoices: rows
          .filter(
            (row) => row.clientOrganizationId === clientOrg && !PORTAL_HIDDEN_STATES.has(row.state),
          )
          .map((row) => portalHeader(row, today)),
      };
    });
  }

  /** The projection; the first read stamps `viewed_at` and the `viewed` event once. */
  async portalGet(
    context: TenantContext,
    principal: Principal,
    id: string,
    meta: RequestMeta = {},
  ): Promise<PortalInvoiceView> {
    const org = context.organizationId;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.repo.findInvoice(tx, org, id);
      if (row === null || PORTAL_HIDDEN_STATES.has(row.state)) throw notFound();
      this.portalClient(principal, row.clientOrganizationId);
      if (row.viewedAt === null) {
        await this.repo.updateInvoice(tx, org, id, { viewedAt: at });
        await this.event(tx, context, id, 'viewed', 'client', meta, {}, at);
      }
      const showNames = (await this.repo.setting(tx, org, PORTAL_SHOW_NAMES_SETTING_KEY)) === 'on';
      const lines = await this.repo.lines(tx, org, id);
      const payments = await this.repo.payments(tx, org, id);
      return {
        ...portalHeader(row, await this.workspaceToday(tx, org)),
        notes: row.notesText,
        lines: lines.map((l) => ({
          description: portalDescription(l, row.language, showNames),
          quantity: l.quantityCenti / 100,
          unit: l.unit,
          unitPriceMinor: Number(l.unitPriceMinor),
          taxBp: l.taxBp,
          netMinor: Number(l.lineNetMinor),
          grossMinor: Number(l.lineGrossMinor),
        })),
        payments: payments.map((p) => ({
          paidOn: p.paidOn,
          amountMinor: Number(p.amountMinor),
          method: p.method,
        })),
      };
    });
  }

  /**
   * 52-13 — the client's print document: the same A4 print document the team prints, behind the
   * portal read's checks (own client organization, never a draft or void; otherwise 404). A
   * by-person line names nobody unless the setting allows it, exactly as the portal read.
   */
  async portalPrint(
    context: TenantContext,
    principal: Principal,
    id: string,
    lang: unknown,
  ): Promise<string> {
    const facts = await this.portalPrintFacts(context, principal, id);
    return renderPrint(facts.view, documentLanguage(lang, facts.view.language), facts);
  }

  /** 52-10 — the client's "Download PDF" of its own invoice, behind the same checks as above. */
  async portalPdf(
    context: TenantContext,
    principal: Principal,
    id: string,
    lang: unknown,
  ): Promise<RecordPdfFile> {
    const facts = await this.portalPrintFacts(context, principal, id);
    return this.documentPdf(facts, documentLanguage(lang, facts.view.language));
  }

  private async portalPrintFacts(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<PrintFacts> {
    const org = context.organizationId;
    return this.options.database.read(context, async (r) => {
      const row = await this.repo.findInvoice(r, org, id);
      if (row === null || PORTAL_HIDDEN_STATES.has(row.state)) throw notFound();
      this.portalClient(principal, row.clientOrganizationId);
      const showNames = (await this.repo.setting(r, org, PORTAL_SHOW_NAMES_SETTING_KEY)) === 'on';
      const full = await this.view(r, org, row);
      const view = { ...full, lines: full.lines.map((l) => portalPrintLine(l, showNames)) };
      return {
        view,
        notice: noticeOf(view),
        ...(await this.printParties(r, org, row, full.state)),
        brand: await this.brand(r, context),
      };
    });
  }

  /** Today's civil date on the workspace's own calendar (its time zone; UTC when unknown). */
  private async workspaceToday(r: TenantQueryRunner, org: string): Promise<string> {
    const organization = await this.options.finance.organization(r, org);
    return localDateOf(this.now(), organization?.timezone ?? 'UTC');
  }

  /**
   * The client principal's organization when it may read invoices (a client admin or member with
   * `client_projection.read`) and, for one invoice, when it is its own. Anything else is a 404.
   */
  private portalClient(principal: Principal, invoiceClientOrg: string | null): string {
    const own = portalMoneyClient(principal);
    if (invoiceClientOrg !== null && invoiceClientOrg !== own) throw notFound();
    return own;
  }

  // ---- helpers ----

  private async view(
    r: TenantQueryRunner,
    org: string,
    row: ClientInvoiceRow,
  ): Promise<InvoiceView> {
    const today = isoDay(this.now());
    const lines = await this.repo.lines(r, org, row.id);
    const payments = await this.repo.payments(r, org, row.id);
    const notes = await this.repo.creditNotes(r, org, row.id);
    const totals = invoiceTotals(lines.map(lineInputOf));
    const total = Number(row.totalMinor);
    return {
      ...invoiceSummary(row, today),
      projectId: row.projectId,
      retainerPeriodId: row.retainerPeriodId,
      quoteId: row.quoteId,
      language: row.language,
      documentLabel: row.documentLabel,
      taxRegistrationRef: row.taxRegistrationRef ?? null,
      taxRegisteredAt: row.taxRegisteredAt?.toISOString() ?? null,
      taxNoticeShown: row.taxNoticeShown === true,
      supplyDate: row.supplyDate,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      baseCurrency: row.baseCurrency,
      fxRate: row.fxRate,
      subtotalMinor: Number(row.subtotalMinor),
      discountMinor: Number(row.discountMinor),
      taxMinor: Number(row.taxMinor),
      depositAppliedMinor: Number(row.depositAppliedMinor),
      taxByRate: totals.taxByRate,
      amountInWords: {
        en: amountInWords(Math.max(0, total), row.currency, 'en'),
        ar: amountInWords(Math.max(0, total), row.currency, 'ar'),
      },
      poNumber: row.poNumber,
      notes: row.notesText,
      internalNote: row.internalNote,
      terms: row.termsText,
      contentHash: row.contentHash,
      sentAt: row.sentAt?.toISOString() ?? null,
      sentTo: row.sentTo,
      viewedAt: row.viewedAt?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidReason: row.voidReason,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lines: lines.map(lineView),
      payments: payments.map((p) => ({
        id: p.id,
        paidOn: p.paidOn,
        amountMinor: Number(p.amountMinor),
        method: p.method,
        reference: p.reference,
        note: p.note,
      })),
      creditNotes: notes.map((n) => ({
        id: n.id,
        number: n.number,
        reason: n.reason,
        totalMinor: Number(n.totalMinor),
        issuedAt: n.issuedAt.toISOString(),
      })),
      pdf: null,
      einvoice:
        row.zatcaStatus === undefined || row.zatcaStatus === 'not_applicable'
          ? null
          : { status: row.zatcaStatus, icv: row.zatcaIcv ?? null },
    };
  }

  /** The row, locked, when it is a draft: 404 when absent, 409 when issued. */
  private async draft(tx: TenantQueryRunner, org: string, id: string): Promise<ClientInvoiceRow> {
    const row = await this.repo.findInvoice(tx, org, id, true);
    if (row === null) throw notFound();
    if (row.state !== 'draft') throw conflict('not_draft');
    return row;
  }

  /** The header money recomputed from the stored lines. */
  private async totals(
    tx: TenantQueryRunner,
    org: string,
    id: string,
  ): Promise<
    Pick<ClientInvoiceRow, 'subtotalMinor' | 'discountMinor' | 'taxMinor' | 'totalMinor'>
  > {
    const totals = invoiceTotals((await this.repo.lines(tx, org, id)).map(lineInputOf));
    return {
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
    };
  }

  /** A PUT's lines: named ones are edited (their source kept), new ones are manual, the rest go. */
  private async replaceLines(
    tx: TenantQueryRunner,
    org: string,
    invoiceId: string,
    inputs: readonly LineInput[],
    at: Date,
  ): Promise<void> {
    const existing = new Map((await this.repo.lines(tx, org, invoiceId)).map((l) => [l.id, l]));
    const kept = new Set<string>();
    const fresh: ClientInvoiceLineRow[] = [];
    for (const [position, input] of inputs.entries()) {
      const amounts = invoiceTotals([lineInputOf(input)]).lines[0]!;
      const values = {
        position,
        descriptionEn: input.descriptionEn,
        descriptionAr: input.descriptionAr,
        quantityCenti: input.quantityCenti,
        unit: input.unit,
        unitPriceMinor: input.unitPriceMinor,
        discountBp: input.discountBp,
        taxBp: input.taxBp,
        lineDiscountMinor: amounts.lineDiscountMinor,
        lineNetMinor: amounts.lineNetMinor,
        lineTaxMinor: amounts.lineTaxMinor,
        lineGrossMinor: amounts.lineGrossMinor,
      };
      if (input.id !== null) {
        if (!existing.has(input.id))
          throw invalid(`lines[${String(position)}].id`, 'not a line of this invoice');
        kept.add(input.id);
        await this.repo.updateLine(tx, org, input.id, values);
      } else {
        fresh.push({
          id: uuidv7(),
          organizationId: org,
          invoiceId,
          sourceType: 'manual',
          taxRateId: null,
          taxCategory: null,
          groupKey: null,
          sourceIdsJson: null,
          createdAt: at,
          ...values,
        });
      }
    }
    await this.repo.deleteLines(
      tx,
      org,
      invoiceId,
      [...existing.keys()].filter((lineId) => !kept.has(lineId)),
    );
    await this.repo.insertLines(tx, fresh);
  }

  private lineRow(
    org: string,
    invoiceId: string,
    position: number,
    line: PulledLine,
    at: Date,
  ): ClientInvoiceLineRow {
    const amounts = invoiceTotals([line]).lines[0]!;
    return {
      id: uuidv7(),
      organizationId: org,
      invoiceId,
      position,
      sourceType: line.sourceType,
      descriptionEn: line.descriptionEn,
      descriptionAr: line.descriptionAr,
      quantityCenti: line.quantityCenti,
      unit: line.unit,
      unitPriceMinor: line.unitPriceMinor,
      discountBp: line.discountBp,
      taxRateId: null,
      taxBp: line.taxBp,
      taxCategory: null,
      lineDiscountMinor: amounts.lineDiscountMinor,
      lineNetMinor: amounts.lineNetMinor,
      lineTaxMinor: amounts.lineTaxMinor,
      lineGrossMinor: amounts.lineGrossMinor,
      groupKey: line.groupKey,
      sourceIdsJson: line.sourceIds.length === 0 ? null : JSON.stringify(line.sourceIds),
      createdAt: at,
    };
  }

  /** A pulled line's sources, linked at send; one already taken by another invoice is a 409. */
  private async link(
    tx: TenantQueryRunner,
    org: string,
    invoiceId: string,
    line: ClientInvoiceLineRow,
    at: Date,
  ): Promise<void> {
    const ids = sourceIdsOf(line.sourceIdsJson);
    if (ids.length === 0) return;
    let linked = 0;
    if (line.sourceType === 'time') linked = await this.repo.linkTimeLogs(tx, org, ids, line.id);
    else if (line.sourceType === 'expense')
      linked = await this.repo.linkExpenses(tx, org, ids, line.id, at);
    else if (line.sourceType === 'retainer') {
      linked = await this.repo.linkRetainerPeriod(tx, org, ids[0]!, invoiceId);
      if (linked === 1) return;
    } else return;
    if (linked !== ids.length) throw conflict('source_already_invoiced', 'lines');
  }

  private async refuseLocked(tx: TenantQueryRunner, org: string, day: string): Promise<void> {
    if ((await this.repo.locksHolding(tx, org, day)).length > 0) throw periodLocked();
  }

  private async rateFor(
    tx: TenantQueryRunner,
    org: string,
    base: string,
    currency: string,
    day: string,
  ): Promise<string | null> {
    if (currency === base) return null;
    const direct = await this.repo.exchangeRate(tx, org, base, currency, day);
    if (direct !== null) return direct;
    const inverse = await this.repo.exchangeRate(tx, org, currency, base, day);
    const rate = inverse === null ? null : invertRate(inverse);
    if (rate === null) throw invalid('currency', 'no_exchange_rate_for_currency');
    return rate;
  }

  private async profile(tx: TenantQueryRunner, org: string): Promise<FinanceProfileValues> {
    const profile = await this.options.finance.profile(tx, org);
    if (profile !== null) return profile;
    return defaultProfile(await this.options.finance.organization(tx, org));
  }

  /**
   * 52-12 (R22-a): sign one chain link with the org's ZATCA certificate. `null` when there is no
   * signer or no active certificate (the link stays `ready`). A failure is audited
   * `client_invoice.sign_failed` with its code and never blocks the send; the organization's third
   * failure in 24 hours (counted from those audit rows, this one included) raises
   * `finance.einvoice_sign_failed.v1`.
   */
  private async signLink(
    tx: TenantQueryRunner,
    context: TenantContext,
    invoiceId: string,
    documentKind: 'invoice' | 'credit_note',
    documentId: string,
    xml: string,
  ): Promise<DocumentSignature | null> {
    const signer = this.options.signing;
    if (signer === undefined || signer === null) return null;
    try {
      return await signer.signDocument(tx, context.organizationId, xml);
    } catch (error) {
      const code = error instanceof SigningFailure ? error.code : 'sign_failed';
      await this.audited(tx, context, 'client_invoice.sign_failed', invoiceId, {
        document: documentKind,
        document_id: documentId,
        code,
      });
      const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1000);
      const failures =
        (await this.options.signingStore?.signFailuresSince(tx, context.organizationId, since)) ??
        0;
      if (failures === 3) {
        await this.options.outbox?.append(tx, context, {
          type: 'finance.einvoice_sign_failed.v1',
          aggregateId: invoiceId,
          payload: { documentId, documentKind, code, failuresIn24h: failures },
        });
      }
      return null;
    }
  }

  private stepUpFresh(context: TenantContext, meta: SendMeta): boolean {
    const secret = this.options.sessionSecret;
    if (secret === undefined || meta.reauthToken === undefined || meta.sessionId === undefined) {
      return false;
    }
    const verified = verifyReauthToken(meta.reauthToken, secret, this.now().getTime());
    return (
      verified.ok &&
      verified.claims.userId === context.userId &&
      verified.claims.sessionId === meta.sessionId
    );
  }

  private async deliver(
    to: readonly string[],
    view: InvoiceView,
    orgSlug: string,
    kind: 'invoice' | 'reminder',
    message: string | null,
    country: string | null,
    attachment: MailAttachment | null = null,
  ): Promise<void> {
    if (this.mailer === null || to.length === 0) return;
    const base = (this.options.webPublicUrl ?? '').replace(/\/+$/u, '');
    const link = `${base}/${encodeURIComponent(orgSlug)}/portal/invoices/${encodeURIComponent(view.id)}`;
    for (const recipient of to) {
      try {
        const mailMessage = composeInvoiceEmail({
          to: recipient,
          view,
          link,
          kind,
          message,
          country,
        });
        // INVMAIL: a PDF over the mailer's size limit is skipped; the link above still reaches it.
        await this.mailer.send(
          attachment === null ? mailMessage : attachIfFits(mailMessage, attachment),
        );
      } catch {
        // A mail failure never undoes an issued invoice; the timeline already holds the send.
      }
    }
  }

  private async event(
    tx: TenantQueryRunner,
    context: TenantContext,
    invoiceId: string,
    kind: string,
    actorKind: 'member' | 'client' | 'system',
    meta: RequestMeta | null,
    payload: Readonly<Record<string, string | number | boolean | null>>,
    at: Date,
  ): Promise<void> {
    await this.repo.insertEvent(tx, {
      id: uuidv7(),
      organizationId: context.organizationId,
      invoiceId,
      kind,
      actorKind,
      actorId: context.userId,
      ip: meta?.ip?.slice(0, 45) ?? null,
      ua: meta?.userAgent?.slice(0, 255) ?? null,
      payloadJson: Object.keys(payload).length === 0 ? null : JSON.stringify(payload),
      createdAt: at,
    });
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    objectId: string,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
    changes: readonly {
      readonly field: string;
      readonly before: unknown;
      readonly after: unknown;
    }[] = [],
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId,
      actorUserId: context.userId,
      metadata,
      changes,
    });
  }

  private allows(principal: Principal, context: TenantContext, capability: Capability): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  private requireView(principal: Principal, context: TenantContext): void {
    if (principal.kind !== 'internal') throw forbidden('client_invoice.internal_only');
    if (!this.allows(principal, context, FINANCE_VIEW)) throw forbidden('client_invoice.view');
  }

  private requireManage(principal: Principal, context: TenantContext): void {
    if (principal.kind !== 'internal') throw forbidden('client_invoice.internal_only');
    if (!this.allows(principal, context, FINANCE_MANAGE)) throw forbidden('client_invoice.manage');
  }
}

// ── projections and rendering ────────────────────────────────────────────────

/** 52-12 (R22-a): the Phase-1 QR fields of a document — the same values `qrFor` encodes. */
function phase1Of(doc: EinvoiceDocument): Phase1QrInput {
  const seller = sellerFromSnapshot(doc.sellerSnapshotJson);
  return {
    sellerName: seller.legalNameAr ?? seller.legalNameEn ?? '',
    vatNumber: seller.taxRegistrationNo ?? '',
    timestamp: doc.issuedAt,
    totalWithVat: twoPlaces(doc.totalMinor, doc.currency),
    vatAmount: twoPlaces(doc.taxMinor, doc.currency),
  };
}

/** 52-28: the notice goes with a document that went out with it, until it is a tax invoice. */
function noticeOf(row: Pick<InvoiceView, 'taxNoticeShown' | 'documentLabel'>): boolean {
  return row.taxNoticeShown && row.documentLabel !== 'tax_invoice';
}

function langOf(language: string): 'en' | 'ar' | 'bi' {
  return language === 'en' || language === 'ar' ? language : 'bi';
}

/** A print line for the client: a by-person line names nobody unless allowed (as the portal read). */
function portalPrintLine(line: InvoiceLineView, showNames: boolean): InvoiceLineView {
  if (line.groupKey?.startsWith('person:') !== true || showNames) return line;
  return { ...line, descriptionEn: PERSON_LINE_EN, descriptionAr: PERSON_LINE_AR };
}

function portalHeader(row: ClientInvoiceRow, today: string): PortalInvoiceSummary {
  const lang = langOf(row.language);
  const amountDueMinor = dueOf(row);
  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    language: row.language,
    state: row.state,
    documentLabel: row.documentLabel,
    documentLabelText: labelCopy(row.documentLabel, lang),
    taxNotice: noticeOf({
      taxNoticeShown: row.taxNoticeShown === true,
      documentLabel: row.documentLabel,
    })
      ? taxNoticeFor(sellerFromSnapshot(row.sellerSnapshotJson).country, lang)
      : null,
    taxRegistrationRef: row.taxRegistrationRef ?? null,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    currency: row.currency,
    subtotalMinor: Number(row.subtotalMinor),
    discountMinor: Number(row.discountMinor),
    taxMinor: Number(row.taxMinor),
    totalMinor: Number(row.totalMinor),
    paidMinor: Number(row.paidMinor),
    amountDueMinor,
    standing: invoiceStanding(row.dueDate, amountDueMinor, today),
  };
}

/** The description in the invoice's language; a by-person line names nobody unless allowed. */
function portalDescription(
  line: ClientInvoiceLineRow,
  language: string,
  showNames: boolean,
): string {
  if (line.groupKey?.startsWith('person:') === true && !showNames) {
    return language === 'ar' ? PERSON_LINE_AR : PERSON_LINE_EN;
  }
  return documentDescription(
    line.descriptionEn,
    line.descriptionAr,
    language === 'ar' || language === 'en' ? language : 'bi',
  );
}

export function composeInvoiceEmail(facts: {
  readonly to: string;
  readonly view: InvoiceView;
  readonly link: string;
  readonly kind: 'invoice' | 'reminder';
  readonly message: string | null;
  /** B6: the seller's country as sent; picks the one authority the notice names. */
  readonly country?: string | null;
}): MailMessage {
  const { view, link } = facts;
  const arabic = view.language === 'ar';
  const number = view.number ?? '';
  // 52-28: the document's label leads the heading; the notice line follows the amount.
  const docLabel = labelCopy(view.documentLabel, arabic ? 'ar' : 'en');
  const notice = noticeOf(view) ? taxNoticeFor(facts.country, arabic ? 'ar' : 'en') : null;
  const amount = formatMinor(view.amountDueMinor, view.currency);
  const due = view.dueDate ?? '';
  const copy = arabic
    ? {
        subject: facts.kind === 'invoice' ? `فاتورة ${number}` : `تذكير بالدفع — فاتورة ${number}`,
        eyebrow: 'فاتورة',
        heading: facts.kind === 'invoice' ? `${docLabel} ${number}` : `تذكير بالفاتورة ${number}`,
        intro:
          facts.kind === 'invoice'
            ? `المبلغ المستحق ${amount} بتاريخ ${due}.`
            : `ما زال مبلغ ${amount} مستحقًا منذ ${due}.`,
        button: 'عرض الفاتورة',
        fallback: 'إذا لم يعمل الزر، انسخ هذا الرابط إلى متصفحك:',
        note: 'تفتح الفاتورة في بوابة العميل بعد تسجيل الدخول.',
        footer: 'وصلتك هذه الرسالة لأنك مدرج كجهة استلام لفواتير هذا الحساب.',
        labelAmount: 'المبلغ المستحق',
        labelDue: 'تاريخ الاستحقاق',
        labelMessage: 'رسالة',
      }
    : {
        subject:
          facts.kind === 'invoice' ? `Invoice ${number}` : `Payment reminder — invoice ${number}`,
        eyebrow: 'Invoice',
        heading: facts.kind === 'invoice' ? `${docLabel} ${number}` : `Reminder: invoice ${number}`,
        intro:
          facts.kind === 'invoice'
            ? `${amount} is due on ${due}.`
            : `${amount} has been due since ${due}.`,
        button: 'View the invoice',
        fallback: 'Button not working? Copy this link into your browser:',
        note: 'The invoice opens in the client portal after you sign in.',
        footer: 'You received this because you are a billing contact for this account.',
        labelAmount: 'Amount due',
        labelDue: 'Due date',
        labelMessage: 'Message',
      };
  const rows = [
    { label: copy.labelAmount, value: amount },
    { label: copy.labelDue, value: due },
    ...(facts.message === null ? [] : [{ label: copy.labelMessage, value: facts.message }]),
  ];
  return {
    to: facts.to,
    subject: copy.subject,
    text: [
      copy.heading,
      copy.intro,
      ...(notice === null ? [] : [notice]),
      ...(facts.message === null ? [] : [facts.message]),
      `${copy.button}: ${link}`,
      copy.note,
      copy.footer,
    ].join('\n\n'),
    html: renderActionEmail({
      arabic,
      link,
      rows,
      subject: copy.subject,
      eyebrow: copy.eyebrow,
      heading: copy.heading,
      intro: notice === null ? copy.intro : `${copy.intro} ${notice}`,
      button: copy.button,
      fallback: copy.fallback,
      note: copy.note,
      footer: copy.footer,
    }),
  };
}

/**
 * The client organization of a principal that may read the portal's money documents (a client
 * admin or member with `client_projection.read` on its own client organization); anything else is
 * the 404 an unknown document gives. 52-10: shared by the invoice and quote portal downloads.
 */
export function portalMoneyClient(principal: Principal): string {
  const own = principal.clientOrganizationId;
  if (principal.kind !== 'client' || own === null || !PORTAL_ROLES.has(principal.role)) {
    throw notFound();
  }
  const allowed = authorize({
    principal,
    capability: 'client_projection.read',
    resource: {
      organizationId: principal.organizationId,
      projectId: null,
      audience: 'client_visible',
      clientOrganizationId: own,
      lifecycle: 'active',
    },
  }).allowed;
  if (!allowed) throw notFound();
  return own;
}

/** What an invoice print or PDF is drawn from, gathered under the read's authorization. */
interface PrintFacts {
  readonly view: InvoiceView;
  readonly notice: boolean;
  readonly parties: PrintParties;
  readonly country: string | null;
  readonly brand: DocumentBrand;
}

/** B5: one party on the print — the seller (agency) or the buyer (client). */
export interface PrintParty {
  readonly nameEn: string | null;
  readonly nameAr: string | null;
  readonly taxRegistrationNo: string | null;
  readonly addressEn: string | null;
  readonly addressAr: string | null;
}

export interface PrintParties {
  readonly seller: PrintParty;
  readonly buyer: PrintParty;
}

function snapshotText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** A sent invoice: the frozen seller/buyer snapshots. */
export function printPartiesFromSnapshots(
  sellerJson: string | null,
  buyerJson: string | null,
): PrintParties {
  const seller = sellerFromSnapshot(sellerJson);
  let buyer: Record<string, unknown> = {};
  try {
    const value: unknown = buyerJson === null ? {} : JSON.parse(buyerJson);
    if (value !== null && typeof value === 'object') buyer = value as Record<string, unknown>;
  } catch {
    buyer = {};
  }
  return {
    seller: {
      nameEn: seller.legalNameEn,
      nameAr: seller.legalNameAr,
      taxRegistrationNo: seller.taxRegistrationNo,
      addressEn: seller.addressEn,
      addressAr: seller.addressAr,
    },
    buyer: {
      nameEn: snapshotText(buyer['legalNameEn']) ?? snapshotText(buyer['name']),
      nameAr: snapshotText(buyer['legalNameAr']),
      taxRegistrationNo: snapshotText(buyer['taxRegistrationNo']),
      addressEn: snapshotText(buyer['addressEn']),
      addressAr: snapshotText(buyer['addressAr']),
    },
  };
}

/** A draft: today's finance profile and the client's billing record. */
export function printPartiesFromRecords(
  profile: FinanceProfileValues,
  client: ClientOrganizationBillingRow | null,
): PrintParties {
  return {
    seller: {
      nameEn: profile.legalNameEn,
      nameAr: profile.legalNameAr,
      taxRegistrationNo: profile.taxRegistrationNo,
      addressEn: profile.addressEn,
      addressAr: profile.addressAr,
    },
    buyer: {
      nameEn: client === null ? null : (client.legalNameEn ?? client.name),
      nameAr: client?.legalNameAr ?? null,
      taxRegistrationNo: client?.taxRegistrationNo ?? null,
      addressEn: client?.billingAddressEn ?? null,
      addressAr: client?.billingAddressAr ?? null,
    },
  };
}

const PRINT_STYLE = [
  'body{font-family:Manrope,Tahoma,Arial,sans-serif;margin:24px;color:#090a09;font-size:13px;line-height:1.45}',
  'h1{font-size:22px;margin:0 0 8px}',
  'h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#74786f;margin:0 0 4px}',
  '.dates{color:#40443d;margin:0 0 16px}',
  '.parties{display:flex;gap:24px;margin:0 0 20px}',
  '.party{flex:1;border:1px solid #e9e9e5;border-radius:6px;padding:10px 12px}',
  '.party p{margin:2px 0}.party .name{font-weight:700}.party .vat{font-variant-numeric:tabular-nums}',
  'table{width:100%;border-collapse:collapse;margin:0 0 16px}',
  'th{background:#f4f4f1;font-weight:600}',
  'td,th{border-bottom:1px solid #e9e9e5;padding:6px;text-align:start;vertical-align:top}',
  '.totals{margin-inline-start:auto;max-width:320px}.totals p{margin:2px 0;text-align:end}',
  '.doc-label{display:inline-block;border:1px solid #090a09;border-radius:4px;padding:2px 8px;font-size:14px;vertical-align:middle}',
  '@page{size:A4;margin:16mm}',
  '@media print{body{margin:0}}',
].join('');

/** The seller and buyer boxes: names, VAT number and address in the print's language(s). */
function partiesBlock(
  parties: PrintParties,
  label: (english: string, arabic: string) => string,
  en: boolean,
  ar: boolean,
): string {
  const e = escapeHtml;
  const pair = (english: string | null, arabicText: string | null): string => {
    const parts = [
      en && english !== null ? e(english) : '',
      ar && arabicText !== null ? `<span lang="ar" dir="rtl">${e(arabicText)}</span>` : '',
    ].filter((part) => part !== '');
    if (parts.length > 0) return parts.join('<br>');
    // Only the other language was entered: print it rather than an empty line.
    const fallback = english ?? arabicText;
    return fallback === null ? '' : e(fallback);
  };
  const box = (heading: string, headingAr: string, party: PrintParty): string => {
    const name = pair(party.nameEn, party.nameAr);
    const address = pair(party.addressEn, party.addressAr);
    return [
      `<section class="party"><h2>${label(heading, headingAr)}</h2>`,
      name === '' ? '' : `<p class="name">${name}</p>`,
      party.taxRegistrationNo === null
        ? ''
        : `<p class="vat">${label('VAT number', 'الرقم الضريبي')}: ${e(party.taxRegistrationNo)}</p>`,
      address === '' ? '' : `<p class="address">${address}</p>`,
      '</section>',
    ].join('');
  };
  return `<div class="parties">${box('From', 'من', parties.seller)}${box('Bill to', 'إلى', parties.buyer)}</div>`;
}

/** The print view: escaped plain text on an A4 page with the parties; both columns when 'bi'. */
export function renderPrint(
  view: InvoiceView,
  language: 'en' | 'ar' | 'bi',
  options: {
    readonly notice: boolean;
    readonly parties?: PrintParties;
    readonly country?: string | null;
  } = { notice: false },
): string {
  const e = escapeHtml;
  const en = language !== 'ar';
  const ar = language !== 'en';
  const label = (english: string, arabic: string): string =>
    [en ? e(english) : '', ar ? `<span lang="ar" dir="rtl">${e(arabic)}</span>` : '']
      .filter((s) => s !== '')
      .join(' / ');
  const money = (minor: number): string => e(formatMinor(minor, view.currency));
  const rows = view.lines
    .map((l) => {
      const description = [
        en && l.descriptionEn !== null ? e(l.descriptionEn) : '',
        ar && l.descriptionAr !== null
          ? `<div lang="ar" dir="rtl">${e(arabicExpenseDescription(l.descriptionAr))}</div>`
          : '',
      ].join('');
      return `<tr><td>${description}</td><td>${e(String(l.quantity))} ${e(unitLabel(l.unit, language))}</td><td>${money(
        l.unitPriceMinor,
      )}</td><td>${e(String(l.taxBp / 100))}%</td><td>${money(l.lineGrossMinor)}</td></tr>`;
    })
    .join('');
  const words = [
    en ? e(view.amountInWords.en) : '',
    ar ? `<div lang="ar" dir="rtl">${e(view.amountInWords.ar)}</div>` : '',
  ].join('');
  return [
    '<!doctype html>',
    `<html lang="${language === 'ar' ? 'ar' : 'en'}" dir="${language === 'ar' ? 'rtl' : 'ltr'}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${e(view.number ?? 'Draft')}</title>`,
    `<style>${PRINT_STYLE}</style>`,
    '</head><body>',
    // 52-28: the label chip at the start of the title line.
    `<h1><span class="doc-label">${label(labelCopy(view.documentLabel, 'en'), labelCopy(view.documentLabel, 'ar'))}</span> ${e(view.number ?? '')}</h1>`,
    `<p class="dates">${label('Issue date', 'تاريخ الإصدار')}: ${e(view.issueDate ?? '')} — ${label('Due date', 'تاريخ الاستحقاق')}: ${e(view.dueDate ?? '')}</p>`,
    options.parties === undefined ? '' : partiesBlock(options.parties, label, en, ar),
    `<table class="lines"><thead><tr><th>${label('Description', 'الوصف')}</th><th>${label('Qty', 'الكمية')}</th><th>${label('Unit price', 'سعر الوحدة')}</th><th>${label('Tax', 'الضريبة')}</th><th>${label('Amount', 'المبلغ')}</th></tr></thead><tbody>${rows}</tbody></table>`,
    '<div class="totals">',
    `<p>${label('Subtotal', 'المجموع الفرعي')}: ${money(view.subtotalMinor)}</p>`,
    `<p>${label('Discount', 'الخصم')}: ${money(view.discountMinor)}</p>`,
    `<p>${label('Tax', 'الضريبة')}: ${money(view.taxMinor)}</p>`,
    `<p><strong>${label('Total', 'الإجمالي')}: ${money(view.totalMinor)}</strong></p>`,
    `<p>${label('Amount due', 'المبلغ المستحق')}: ${money(view.amountDueMinor)}</p>`,
    '</div>',
    options.notice
      ? `<p class="tax-notice">${label(taxNoticeFor(options.country, 'en'), taxNoticeFor(options.country, 'ar'))}</p>`
      : '',
    `<div>${words}</div>`,
    view.terms === null ? '' : `<p style="white-space:pre-wrap">${e(view.terms)}</p>`,
    view.notes === null ? '' : `<p style="white-space:pre-wrap">${e(view.notes)}</p>`,
    view.taxRegistrationRef === null
      ? ''
      : `<p class="tax-ref" style="font-size:10px">${label('Registered reference as entered by the agency', 'المرجع المسجل كما أدخلته الوكالة')}: ${e(view.taxRegistrationRef)}</p>`,
    view.contentHash === null
      ? ''
      : `<p style="font-size:10px;color:#74786f">${e(view.contentHash)}</p>`,
    '</body></html>',
  ].join('\n');
}
