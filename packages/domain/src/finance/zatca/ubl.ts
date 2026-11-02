import { CURRENCY_DIGITS } from '../../money/money.js';
import type { StructuredAddress } from './address.js';
import { sha256Hex, utf8 } from './bytes.js';

/**
 * 52-12 (R21-c) — the UBL 2.1 invoice XML for the two structured regimes: ZATCA (KSA, Phase 2
 * layout) and the UAE PINT-AE profile. Hand-built, escaped string (no XML dependency).
 *
 * The document is UNSIGNED: the ZATCA `ext:UBLExtensions` signature block, the QR
 * `AdditionalDocumentReference` and the cryptographic stamp need the customer-held certificate and
 * are a later pass. ICV and PIH are emitted only when given (the hash chain lands in slice d).
 * Pure, no I/O.
 */

export type UblProfile = 'zatca' | 'pint_ae';
export type UblTaxCategory = 'S' | 'Z' | 'E' | 'O';

export interface UblParty {
  readonly legalName: string;
  readonly vatNumber: string | null;
  readonly address: StructuredAddress | null;
}

export interface UblLine {
  readonly position: number;
  readonly description: string;
  /** Decimal string or a number, e.g. `2` or `1.5`. */
  readonly quantity: number | string;
  readonly unitPriceMinor: number;
  readonly lineNetMinor: number;
  readonly lineTaxMinor: number;
  readonly taxCategory: UblTaxCategory;
  readonly taxRateBp: number;
  /** Overrides the default exemption reason code for E / O / Z lines. */
  readonly exemptionReasonCode?: string;
}

export interface UblInvoiceInput {
  readonly profile: UblProfile;
  /** The invoice UUID (the row id). */
  readonly id: string;
  readonly number: string;
  readonly kind: 'invoice' | 'credit_note';
  /** `YYYY-MM-DD`. */
  readonly issueDate: string;
  /** `HH:mm:ss`; defaults to `00:00:00`. */
  readonly issueTime?: string;
  /** `YYYY-MM-DD`. */
  readonly supplyDate: string;
  readonly currency: string;
  readonly seller: UblParty & { readonly vatNumber: string; readonly address: StructuredAddress };
  readonly buyer: UblParty;
  readonly icv: number | null;
  readonly pih: string | null;
  /** The invoice a credit note corrects (number), and the reason it is issued. */
  readonly billingReference?: string | null;
  readonly creditReason?: string | null;
  readonly lines: readonly UblLine[];
  readonly totals: {
    readonly subtotalMinor: number;
    readonly discountMinor: number;
    readonly taxMinor: number;
    readonly totalMinor: number;
  };
  /** UNCL 4461: `10` cash (default), `30` credit transfer, `42` bank account, `48` card. */
  readonly paymentMeansCode?: string;
}

/** ZATCA XML Implementation Standard: the business-process profile of every invoice. */
export const ZATCA_PROFILE_ID = 'reporting:1.0';
/** PINT-AE (UAE) specification identifier and business process. */
export const PINT_AE_CUSTOMIZATION_ID = 'urn:peppol:pint:billing-1@ae-1';
export const PINT_AE_PROFILE_ID = 'urn:peppol:bis:billing';

/** ZATCA `InvoiceTypeCode/@name`: standard (B2B, buyer VAT number) vs simplified (B2C). */
export const ZATCA_STANDARD_SUBTYPE = '0100000';
export const ZATCA_SIMPLIFIED_SUBTYPE = '0200000';

/** UNCL 1001 document type codes. */
export const UBL_TYPE_CODES = { invoice: '388', credit_note: '381' } as const;

/** ZATCA VAT exemption reason codes (default per category) and their English reasons. */
export const ZATCA_EXEMPTION_REASONS: Readonly<Record<string, string>> = {
  'VATEX-SA-29': 'Financial services mentioned in Article 29 of the VAT Regulations',
  'VATEX-SA-29-7': 'Life insurance services mentioned in Article 29 of the VAT Regulations',
  'VATEX-SA-30': 'Real estate transactions mentioned in Article 30 of the VAT Regulations',
  'VATEX-SA-32': 'Export of goods',
  'VATEX-SA-33': 'Export of services',
  'VATEX-SA-34-1': 'The international transport of Goods',
  'VATEX-SA-35': 'Medicines and medical equipment',
  'VATEX-SA-36': 'Qualifying metals',
  'VATEX-SA-EDU': 'Private education to citizen',
  'VATEX-SA-HEA': 'Private healthcare to citizen',
  'VATEX-SA-OOS': 'Not subject to VAT',
};
export const ZATCA_DEFAULT_EXEMPTION: Readonly<Record<'Z' | 'E' | 'O', string>> = {
  Z: 'VATEX-SA-33',
  E: 'VATEX-SA-29',
  O: 'VATEX-SA-OOS',
};

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** XML text/attribute escape; also drops characters XML 1.0 forbids. Arabic passes unchanged. */
export function escapeXml(value: string): string {
  return value
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[&<>"']/gu, (char) => ESCAPES[char] ?? char);
}

function digitsFor(currency: string): number {
  return CURRENCY_DIGITS[currency] ?? 2;
}

/** Minor units → a fixed-point decimal string with the currency's exponent. */
export function minorToUblDecimal(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError('amount must be a whole minor amount');
  const digits = digitsFor(currency);
  const negative = minor < 0;
  const raw = String(Math.abs(minor)).padStart(digits + 1, '0');
  const whole = digits === 0 ? raw : raw.slice(0, -digits);
  const fraction = digits === 0 ? '' : `.${raw.slice(-digits)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

function percent(rateBp: number): string {
  return (rateBp / 100).toFixed(2);
}

function el(name: string, value: string, attributes = ''): string {
  return `<${name}${attributes}>${escapeXml(value)}</${name}>`;
}

function amount(name: string, minor: number, currency: string): string {
  return el(name, minorToUblDecimal(minor, currency), ` currencyID="${escapeXml(currency)}"`);
}

function address(value: StructuredAddress | null): string {
  if (value === null) return '';
  const parts = [
    value.street === '' ? '' : el('cbc:StreetName', value.street),
    value.building === '' ? '' : el('cbc:BuildingNumber', value.building),
    value.district === '' ? '' : el('cbc:CitySubdivisionName', value.district),
    value.city === '' ? '' : el('cbc:CityName', value.city),
    value.postalCode === '' ? '' : el('cbc:PostalZone', value.postalCode),
    value.countryCode === ''
      ? ''
      : `<cac:Country>${el('cbc:IdentificationCode', value.countryCode)}</cac:Country>`,
  ];
  return `<cac:PostalAddress>${parts.join('')}</cac:PostalAddress>`;
}

function party(wrapper: string, value: UblParty): string {
  const tax =
    value.vatNumber === null || value.vatNumber === ''
      ? ''
      : `<cac:PartyTaxScheme>${el('cbc:CompanyID', value.vatNumber)}<cac:TaxScheme>${el('cbc:ID', 'VAT')}</cac:TaxScheme></cac:PartyTaxScheme>`;
  return (
    `<${wrapper}><cac:Party>${address(value.address)}${tax}` +
    `<cac:PartyLegalEntity>${el('cbc:RegistrationName', value.legalName)}</cac:PartyLegalEntity>` +
    `</cac:Party></${wrapper}>`
  );
}

function exemptionCode(profile: UblProfile, line: UblLine): string | null {
  if (line.taxCategory === 'S') return null;
  if (line.exemptionReasonCode !== undefined) return line.exemptionReasonCode;
  return profile === 'zatca' ? ZATCA_DEFAULT_EXEMPTION[line.taxCategory] : null;
}

function taxCategory(
  tag: 'cac:TaxCategory' | 'cac:ClassifiedTaxCategory',
  category: UblTaxCategory,
  rateBp: number,
  reasonCode: string | null,
): string {
  const reason =
    tag === 'cac:TaxCategory' && reasonCode !== null
      ? el('cbc:TaxExemptionReasonCode', reasonCode) +
        el('cbc:TaxExemptionReason', ZATCA_EXEMPTION_REASONS[reasonCode] ?? reasonCode)
      : '';
  return (
    `<${tag}>${el('cbc:ID', category)}${el('cbc:Percent', percent(rateBp))}${reason}` +
    `<cac:TaxScheme>${el('cbc:ID', 'VAT')}</cac:TaxScheme></${tag}>`
  );
}

interface Subtotal {
  readonly category: UblTaxCategory;
  readonly rateBp: number;
  readonly reasonCode: string | null;
  taxableMinor: number;
  taxMinor: number;
}

/** Lines grouped by category, rate and exemption reason, in first-seen order. */
export function taxSubtotals(profile: UblProfile, lines: readonly UblLine[]): readonly Subtotal[] {
  const groups = new Map<string, Subtotal>();
  for (const line of lines) {
    const reasonCode = exemptionCode(profile, line);
    const key = `${line.taxCategory}|${line.taxRateBp}|${reasonCode ?? ''}`;
    const group = groups.get(key) ?? {
      category: line.taxCategory,
      rateBp: line.taxRateBp,
      reasonCode,
      taxableMinor: 0,
      taxMinor: 0,
    };
    group.taxableMinor += line.lineNetMinor;
    group.taxMinor += line.lineTaxMinor;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function invoiceLine(input: UblInvoiceInput, line: UblLine): string {
  const c = input.currency;
  const quantityTag =
    input.kind === 'credit_note' ? 'cbc:CreditedQuantity' : 'cbc:InvoicedQuantity';
  const lineTag = input.kind === 'credit_note' ? 'cac:CreditNoteLine' : 'cac:InvoiceLine';
  return (
    `<${lineTag}>${el('cbc:ID', String(line.position))}` +
    el(quantityTag, String(line.quantity), ' unitCode="PCE"') +
    amount('cbc:LineExtensionAmount', line.lineNetMinor, c) +
    `<cac:TaxTotal>${amount('cbc:TaxAmount', line.lineTaxMinor, c)}` +
    `${amount('cbc:RoundingAmount', line.lineNetMinor + line.lineTaxMinor, c)}</cac:TaxTotal>` +
    `<cac:Item>${el('cbc:Name', line.description)}` +
    `${taxCategory('cac:ClassifiedTaxCategory', line.taxCategory, line.taxRateBp, null)}</cac:Item>` +
    `<cac:Price>${amount('cbc:PriceAmount', line.unitPriceMinor, c)}</cac:Price>` +
    `</${lineTag}>`
  );
}

function header(input: UblInvoiceInput): string {
  const typeCode = UBL_TYPE_CODES[input.kind];
  const hasBuyerVat = input.buyer.vatNumber !== null && input.buyer.vatNumber !== '';
  const subtype = hasBuyerVat ? ZATCA_STANDARD_SUBTYPE : ZATCA_SIMPLIFIED_SUBTYPE;
  const ids =
    input.profile === 'zatca'
      ? el('cbc:ProfileID', ZATCA_PROFILE_ID)
      : el('cbc:CustomizationID', PINT_AE_CUSTOMIZATION_ID) +
        el('cbc:ProfileID', PINT_AE_PROFILE_ID);
  const typeTag = input.kind === 'credit_note' ? 'cbc:CreditNoteTypeCode' : 'cbc:InvoiceTypeCode';
  const typeAttr = input.profile === 'zatca' ? ` name="${subtype}"` : '';
  return (
    ids +
    el('cbc:ID', input.number) +
    el('cbc:UUID', input.id) +
    el('cbc:IssueDate', input.issueDate) +
    el('cbc:IssueTime', input.issueTime ?? '00:00:00') +
    el(typeTag, typeCode, typeAttr) +
    el('cbc:DocumentCurrencyCode', input.currency) +
    el('cbc:TaxCurrencyCode', input.currency)
  );
}

function references(input: UblInvoiceInput): string {
  let out = '';
  if (input.billingReference !== undefined && input.billingReference !== null) {
    out += `<cac:BillingReference><cac:InvoiceDocumentReference>${el('cbc:ID', input.billingReference)}</cac:InvoiceDocumentReference></cac:BillingReference>`;
  }
  if (input.icv !== null) {
    out += `<cac:AdditionalDocumentReference>${el('cbc:ID', 'ICV')}${el('cbc:UUID', String(input.icv))}</cac:AdditionalDocumentReference>`;
  }
  if (input.pih !== null) {
    out +=
      `<cac:AdditionalDocumentReference>${el('cbc:ID', 'PIH')}<cac:Attachment>` +
      el('cbc:EmbeddedDocumentBinaryObject', input.pih, ' mimeCode="text/plain"') +
      `</cac:Attachment></cac:AdditionalDocumentReference>`;
  }
  return out;
}

function taxTotals(input: UblInvoiceInput): string {
  const c = input.currency;
  const subtotals = taxSubtotals(input.profile, input.lines)
    .map(
      (group) =>
        `<cac:TaxSubtotal>${amount('cbc:TaxableAmount', group.taxableMinor, c)}` +
        amount('cbc:TaxAmount', group.taxMinor, c) +
        taxCategory('cac:TaxCategory', group.category, group.rateBp, group.reasonCode) +
        `</cac:TaxSubtotal>`,
    )
    .join('');
  const detailed = `<cac:TaxTotal>${amount('cbc:TaxAmount', input.totals.taxMinor, c)}${subtotals}</cac:TaxTotal>`;
  // ZATCA carries a second TaxTotal with the amount in the tax currency only.
  return input.profile === 'zatca'
    ? `<cac:TaxTotal>${amount('cbc:TaxAmount', input.totals.taxMinor, c)}</cac:TaxTotal>${detailed}`
    : detailed;
}

function monetaryTotal(input: UblInvoiceInput): string {
  const c = input.currency;
  const { subtotalMinor, discountMinor, taxMinor, totalMinor } = input.totals;
  const lineExtension = input.lines.reduce((sum, line) => sum + line.lineNetMinor, 0);
  return (
    `<cac:LegalMonetaryTotal>${amount('cbc:LineExtensionAmount', lineExtension, c)}` +
    amount('cbc:TaxExclusiveAmount', subtotalMinor - discountMinor, c) +
    amount('cbc:TaxInclusiveAmount', subtotalMinor - discountMinor + taxMinor, c) +
    amount('cbc:AllowanceTotalAmount', discountMinor, c) +
    amount('cbc:PayableAmount', totalMinor, c) +
    `</cac:LegalMonetaryTotal>`
  );
}

/** The UBL 2.1 document; same input → byte-identical output. */
export function buildUblInvoice(input: UblInvoiceInput): string {
  const root = input.kind === 'credit_note' ? 'CreditNote' : 'Invoice';
  const namespace = `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`;
  const delivery = `<cac:Delivery>${el('cbc:ActualDeliveryDate', input.supplyDate)}</cac:Delivery>`;
  const reason =
    input.kind === 'credit_note' && input.creditReason !== undefined && input.creditReason !== null
      ? el('cbc:InstructionNote', input.creditReason)
      : '';
  const payment = `<cac:PaymentMeans>${el('cbc:PaymentMeansCode', input.paymentMeansCode ?? '10')}${reason}</cac:PaymentMeans>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${root} xmlns="${namespace}" ` +
    `xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" ` +
    `xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">` +
    header(input) +
    references(input) +
    party('cac:AccountingSupplierParty', input.seller) +
    party('cac:AccountingCustomerParty', input.buyer) +
    delivery +
    payment +
    taxTotals(input) +
    monetaryTotal(input) +
    input.lines.map((line) => invoiceLine(input, line)).join('') +
    `</${root}>`
  );
}

/** SHA-256 hex of the XML's UTF-8 bytes. */
export function xmlHash(xml: string): string {
  return sha256Hex(utf8(xml));
}
