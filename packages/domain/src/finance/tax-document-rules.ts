/**
 * 52-28 (R19-a) — tax-document labelling per country. Pure; no I/O.
 *
 * A document TManage generates is labelled as what it legally is. In a country with a mandatory
 * e-invoice system (KSA: ZATCA, Egypt: ETA) a document outside that system is not a tax invoice,
 * so a VAT-registered organization there defaults to a proforma invoice and may use the label
 * "tax invoice" only once a registration reference is recorded. 52-12 (ZATCA) later sets the KSA
 * condition from the clearance status; until then the reference is entered by hand.
 *
 * Rows below were taken from the 52-28 plan (52-FEATURE-GAPS-AGENCY-CORE.md §16.2) on 2026-11-02;
 * they were NOT re-verified online in this slice — the ZATCA Phase-2 wave list and the ETA scope
 * must be checked against the authorities' pages before 52-12 relies on them.
 */

export const DOCUMENT_LABELS = ['invoice', 'proforma', 'commercial', 'tax_invoice'] as const;
export type DocumentLabel = (typeof DOCUMENT_LABELS)[number];

export const VAT_REGISTRATION_STATUSES = ['not_registered', 'registered'] as const;
export type VatRegistrationStatus = (typeof VAT_REGISTRATION_STATUSES)[number];

export const EINVOICE_REGIMES = ['zatca', 'eta', 'pint_ae', 'none'] as const;
export type EinvoiceRegime = (typeof EINVOICE_REGIMES)[number];

export interface TaxDocumentRule {
  readonly regime: EinvoiceRegime;
  readonly defaultLabel: DocumentLabel;
  /** What `tax_invoice` needs beyond VAT registration. */
  readonly taxInvoiceRequires: 'tax_registration_ref' | 'none';
}

export const TAX_DOCUMENT_RULES = {
  /**
   * Saudi Arabia — ZATCA e-invoicing (Fatoora): Phase 1 generation since 2021-12-04, Phase 2
   * integration in waves. Source: zatca.gov.sa e-invoicing pages (per plan, 2026-11-02).
   * 52-12 replaces the hand-entered reference with `zatca_status ∈ {cleared, reported}`.
   */
  SA: { regime: 'zatca', defaultLabel: 'proforma', taxInvoiceRequires: 'tax_registration_ref' },
  /**
   * Egypt — ETA e-invoice mandate for registered taxpayers. Source: eta.gov.eg e-invoicing
   * (per plan, 2026-11-02). The ETA document uuid is entered by hand (doc 54 connector later).
   */
  EG: { regime: 'eta', defaultLabel: 'proforma', taxInvoiceRequires: 'tax_registration_ref' },
  /**
   * UAE — PINT-AE e-invoicing not yet in force for this rule (per plan, 2026-11-02): a normal
   * invoice is the document, no notice.
   */
  AE: { regime: 'pint_ae', defaultLabel: 'invoice', taxInvoiceRequires: 'none' },
  /** Every other country: no mandatory e-invoice system assumed. */
  default: { regime: 'none', defaultLabel: 'invoice', taxInvoiceRequires: 'none' },
} as const satisfies Record<string, TaxDocumentRule>;

/** The rule row for an ISO 3166 alpha-2 country (unknown → `default`). */
export function taxDocumentRuleFor(country: string): TaxDocumentRule {
  const key = country.toUpperCase();
  return key === 'SA' || key === 'EG' || key === 'AE'
    ? TAX_DOCUMENT_RULES[key]
    : TAX_DOCUMENT_RULES.default;
}

export function isDocumentLabel(value: unknown): value is DocumentLabel {
  return typeof value === 'string' && (DOCUMENT_LABELS as readonly string[]).includes(value);
}

export function isEinvoiceRegime(value: unknown): value is EinvoiceRegime {
  return typeof value === 'string' && (EINVOICE_REGIMES as readonly string[]).includes(value);
}

/** The regime in force: the profile override, else the country's. */
export function resolvedRegime(country: string, override: string | null): EinvoiceRegime {
  return isEinvoiceRegime(override) ? override : taxDocumentRuleFor(country).regime;
}

/** The label a new draft gets: a VAT-unregistered organization issues a plain invoice anywhere. */
export function defaultLabelFor(country: string, vatStatus: string): DocumentLabel {
  if (vatStatus !== 'registered') return 'invoice';
  return taxDocumentRuleFor(country).defaultLabel;
}

export type LabelCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'tax_invoice_requires_registration' };

/**
 * Whether a label may be put on a document. Only `tax_invoice` is restricted: it needs VAT
 * registration everywhere and, where the rule says so, a recorded registration reference.
 */
export function canUseLabel(input: {
  readonly country: string;
  readonly vatStatus: string;
  readonly label: DocumentLabel;
  readonly taxRegistrationRef: string | null;
}): LabelCheck {
  if (input.label !== 'tax_invoice') return { ok: true };
  const refused = { ok: false, reason: 'tax_invoice_requires_registration' } as const;
  if (input.vatStatus !== 'registered') return refused;
  const rule = taxDocumentRuleFor(input.country);
  if (rule.taxInvoiceRequires === 'tax_registration_ref') {
    const ref = input.taxRegistrationRef?.trim() ?? '';
    if (ref === '') return refused;
  }
  return { ok: true };
}

/** The "not a tax invoice" line is required in KSA/EG on anything but a tax invoice. */
export function taxNoticeRequired(country: string, label: string): boolean {
  const regime = taxDocumentRuleFor(country).regime;
  return (regime === 'zatca' || regime === 'eta') && label !== 'tax_invoice';
}

const ETA_REF = /^[0-9A-Z]{26}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PRINTABLE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u;

/** The shape of a registration reference: ETA 26 upper-case alphanumerics, ZATCA a UUID v4. */
export function isValidTaxRef(regime: string, ref: string): boolean {
  if (regime === 'eta') return ETA_REF.test(ref);
  if (regime === 'zatca') return UUID_V4.test(ref);
  return ref.length <= 64 && PRINTABLE.test(ref);
}

const LABEL_COPY: Readonly<Record<DocumentLabel, { readonly en: string; readonly ar: string }>> = {
  invoice: { en: 'Invoice', ar: 'فاتورة' },
  proforma: { en: 'Proforma invoice', ar: 'فاتورة مبدئية' },
  commercial: { en: 'Commercial invoice', ar: 'فاتورة تجارية' },
  tax_invoice: { en: 'Tax invoice', ar: 'فاتورة ضريبية' },
};

/** The label's words; `bi` gives "English / العربية". Unknown labels read as a plain invoice. */
export function labelCopy(label: string, lang: 'en' | 'ar' | 'bi'): string {
  const copy = isDocumentLabel(label) ? LABEL_COPY[label] : LABEL_COPY.invoice;
  if (lang === 'bi') return `${copy.en} / ${copy.ar}`;
  return copy[lang];
}

const NOTICE_EN =
  'This document is not a tax invoice. A tax invoice will follow once it is registered with ZATCA/ETA.';
const NOTICE_AR =
  'هذه الوثيقة ليست فاتورة ضريبية. سيتم إصدار الفاتورة الضريبية بعد تسجيلها لدى هيئة الزكاة والضريبة والجمارك / مصلحة الضرائب المصرية.';

/** The notice line (EN, AR, or both on two lines for `bi`). */
export function taxNoticeCopy(lang: 'en' | 'ar' | 'bi'): string {
  if (lang === 'en') return NOTICE_EN;
  if (lang === 'ar') return NOTICE_AR;
  return `${NOTICE_EN}\n${NOTICE_AR}`;
}
