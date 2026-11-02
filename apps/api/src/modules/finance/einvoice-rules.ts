import { createHash } from 'node:crypto';
import {
  buildUblInvoice,
  currencyDigits,
  parseAddressJson,
  phase1Qr,
  xmlHash,
} from '@tmanage/domain';
import type {
  StructuredAddress,
  UblInvoiceInput,
  UblLine,
  UblProfile,
  UblTaxCategory,
} from '@tmanage/domain';
import type {
  ClientCreditNoteLineRow,
  ClientInvoiceLineRow,
  ClientInvoiceRow,
} from '../../common/database/schema.js';

/**
 * 52-12 (R21-d, 0311) — the e-invoice hash chain and the inputs of the UBL XML / Phase-1 QR built
 * from STORED data (the row, its lines and its seller/buyer snapshots), so a rebuild is
 * byte-identical and its hash is the tamper check. Pure, no I/O.
 *
 * The chain: every issued fiscal document of a `zatca` organization (invoices and credit notes,
 * one counter) gets `icv` = previous + 1 (the first is 1) and `pih` = the previous document's XML
 * hash (the first is SHA-256 of '0'). The caller holds the chain lock (see
 * `ClientInvoicesRepository.lockChain`) so the counter stays gapless.
 */

/** ZATCA: the PIH of the first document is the SHA-256 of the string '0' (hex). */
export const GENESIS_PIH = createHash('sha256').update('0', 'utf8').digest('hex');

export const EINVOICE_STATUSES = [
  'not_applicable',
  'ready',
  'signed',
  'reported',
  'cleared',
  'rejected',
] as const;
export type EinvoiceStatus = (typeof EINVOICE_STATUSES)[number];

export interface ChainPosition {
  readonly icv: number;
  readonly pih: string;
}

export interface ChainLink extends ChainPosition {
  readonly xmlHash: string;
  readonly xml: string;
}

/** The next link after `previous` (null for the first): the XML is built with the link's icv/pih. */
export function chainLink(
  previous: { readonly icv: number; readonly xmlHash: string } | null,
  build: (position: ChainPosition) => string,
): ChainLink {
  const position: ChainPosition =
    previous === null
      ? { icv: 1, pih: GENESIS_PIH }
      : { icv: Number(previous.icv) + 1, pih: previous.xmlHash };
  const xml = build(position);
  return { ...position, xml, xmlHash: xmlHash(xml) };
}

/** The UBL profile of a regime; null when the regime has no structured e-invoice. */
export function ublProfileOf(regime: string | null | undefined): UblProfile | null {
  return regime === 'zatca' || regime === 'pint_ae' ? regime : null;
}

/** The seller as the send froze it (`seller_snapshot_json`). */
export interface EinvoiceSeller {
  readonly legalNameEn: string | null;
  readonly legalNameAr: string | null;
  readonly taxRegistrationNo: string | null;
  readonly addressEn: string | null;
  readonly addressAr: string | null;
  readonly country: string | null;
  readonly address: StructuredAddress | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parsed(json: string | null | undefined): Record<string, unknown> {
  if (json === null || json === undefined) return {};
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function sellerFromSnapshot(json: string | null | undefined): EinvoiceSeller {
  const s = parsed(json);
  return {
    legalNameEn: text(s['legalNameEn']),
    legalNameAr: text(s['legalNameAr']),
    taxRegistrationNo: text(s['taxRegistrationNo']),
    addressEn: text(s['addressEn']),
    addressAr: text(s['addressAr']),
    country: text(s['country']),
    address: parseAddressJson(s['address'] ?? null),
  };
}

/** The free-text line goes into `street` when no structured address exists; the XML still builds. */
function freeTextAddress(line: string | null, countryCode: string | null): StructuredAddress {
  return {
    building: '',
    street: line ?? '',
    district: '',
    city: '',
    postalCode: '',
    countryCode: (countryCode ?? '').toUpperCase(),
  };
}

function sellerName(seller: EinvoiceSeller, profile: UblProfile): string {
  return profile === 'zatca'
    ? (seller.legalNameAr ?? seller.legalNameEn ?? '')
    : (seller.legalNameEn ?? seller.legalNameAr ?? '');
}

const CATEGORIES: ReadonlySet<string> = new Set(['S', 'Z', 'E', 'O']);

function categoryOf(stored: string | null | undefined, taxBp: number): UblTaxCategory {
  if (stored !== null && stored !== undefined && CATEGORIES.has(stored)) {
    return stored as UblTaxCategory;
  }
  return taxBp > 0 ? 'S' : 'Z';
}

function description(language: string, en: string | null, ar: string | null): string {
  return language === 'ar' ? (ar ?? en ?? '') : (en ?? ar ?? '');
}

function quantity(centi: number): string {
  return String(centi / 100);
}

export function invoiceUblLines(
  lines: readonly ClientInvoiceLineRow[],
  language: string,
): readonly UblLine[] {
  return [...lines]
    .sort((a, b) => a.position - b.position)
    .map((line) => ({
      position: line.position + 1,
      description: description(language, line.descriptionEn, line.descriptionAr),
      quantity: quantity(line.quantityCenti),
      unitPriceMinor: Number(line.unitPriceMinor),
      lineNetMinor: Number(line.lineNetMinor),
      lineTaxMinor: Number(line.lineTaxMinor),
      taxCategory: categoryOf(line.taxCategory, line.taxBp),
      taxRateBp: line.taxBp,
    }));
}

export function creditNoteUblLines(
  lines: readonly ClientCreditNoteLineRow[],
  language: string,
): readonly UblLine[] {
  return [...lines]
    .sort((a, b) => a.position - b.position)
    .map((line) => ({
      position: line.position + 1,
      description: description(language, line.descriptionEn, line.descriptionAr),
      quantity: quantity(line.quantityCenti),
      unitPriceMinor: Number(line.unitPriceMinor),
      lineNetMinor: Number(line.lineNetMinor),
      lineTaxMinor: Number(line.lineTaxMinor),
      taxCategory: categoryOf(null, line.taxBp),
      taxRateBp: line.taxBp,
    }));
}

/** One issued fiscal document, invoice or credit note, as the XML needs it. */
export interface EinvoiceDocument {
  readonly id: string;
  readonly number: string;
  readonly kind: 'invoice' | 'credit_note';
  readonly issuedAt: Date;
  readonly issueDate: string;
  readonly supplyDate: string | null;
  readonly currency: string;
  readonly buyerSnapshotJson: string | null;
  readonly sellerSnapshotJson: string | null;
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly billingReference?: string | null;
  readonly creditReason?: string | null;
}

export function invoiceDocument(row: ClientInvoiceRow): EinvoiceDocument {
  const issuedAt = row.sentAt ?? row.updatedAt;
  return {
    id: row.id,
    number: row.number ?? '',
    kind: 'invoice',
    issuedAt,
    issueDate: row.issueDate ?? issuedAt.toISOString().slice(0, 10),
    supplyDate: row.supplyDate,
    currency: row.currency,
    buyerSnapshotJson: row.buyerSnapshotJson,
    sellerSnapshotJson: row.sellerSnapshotJson,
    subtotalMinor: Number(row.subtotalMinor),
    discountMinor: Number(row.discountMinor),
    taxMinor: Number(row.taxMinor),
    totalMinor: Number(row.totalMinor),
  };
}

/** The UBL input of a stored document; `position` is null outside the zatca chain. */
export function ublInputFor(
  doc: EinvoiceDocument,
  lines: readonly UblLine[],
  profile: UblProfile,
  position: ChainPosition | null,
): UblInvoiceInput {
  const seller = sellerFromSnapshot(doc.sellerSnapshotJson);
  const buyer = parsed(doc.buyerSnapshotJson);
  const buyerLine = text(buyer['addressEn']) ?? text(buyer['addressAr']);
  const buyerName =
    profile === 'zatca'
      ? (text(buyer['legalNameAr']) ?? text(buyer['legalNameEn']) ?? text(buyer['name']) ?? '')
      : (text(buyer['legalNameEn']) ?? text(buyer['legalNameAr']) ?? text(buyer['name']) ?? '');
  return {
    profile,
    id: doc.id,
    number: doc.number,
    kind: doc.kind,
    issueDate: doc.issueDate,
    issueTime: doc.issuedAt.toISOString().slice(11, 19),
    supplyDate: doc.supplyDate ?? doc.issueDate,
    currency: doc.currency,
    seller: {
      legalName: sellerName(seller, profile),
      vatNumber: seller.taxRegistrationNo ?? '',
      address:
        seller.address ?? freeTextAddress(seller.addressEn ?? seller.addressAr, seller.country),
    },
    buyer: {
      legalName: buyerName,
      vatNumber: text(buyer['taxRegistrationNo']),
      address: buyerLine === null ? null : freeTextAddress(buyerLine, null),
    },
    icv: position?.icv ?? null,
    pih: position?.pih ?? null,
    billingReference: doc.billingReference ?? null,
    creditReason: doc.creditReason ?? null,
    lines,
    totals: {
      subtotalMinor: doc.subtotalMinor,
      discountMinor: doc.discountMinor,
      taxMinor: doc.taxMinor,
      totalMinor: doc.totalMinor,
    },
  };
}

/** The XML of a stored document (deterministic: same rows → same bytes). */
export function einvoiceXml(
  doc: EinvoiceDocument,
  lines: readonly UblLine[],
  profile: UblProfile,
  position: ChainPosition | null,
): string {
  return buildUblInvoice(ublInputFor(doc, lines, profile, position));
}

/** Minor units as a two-place decimal (the QR's amount format, whatever the currency's digits). */
export function twoPlaces(minor: number, currency: string): string {
  return (minor / 10 ** currencyDigits(currency)).toFixed(2);
}

/** The ZATCA Phase-1 QR (TLV base64): seller legal name (AR else EN), TRN, sent time, total, tax. */
export function qrFor(doc: EinvoiceDocument): string {
  const seller = sellerFromSnapshot(doc.sellerSnapshotJson);
  return phase1Qr({
    sellerName: seller.legalNameAr ?? seller.legalNameEn ?? '',
    vatNumber: seller.taxRegistrationNo ?? '',
    timestamp: doc.issuedAt,
    totalWithVat: twoPlaces(doc.totalMinor, doc.currency),
    vatAmount: twoPlaces(doc.taxMinor, doc.currency),
  });
}
