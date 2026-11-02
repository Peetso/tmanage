import { fromBase64, fromUtf8, toBase64, utf8 } from './bytes.js';

/**
 * 52-12 (R21-c) — the ZATCA Phase-1 (generation) QR payload: TLV tags 1–5, base64. Each field is
 * one tag byte, one length byte (the UTF-8 byte length, ≤ 255) and the UTF-8 value. Tags 6–9
 * (hash, signature, public key, stamp) need the Phase-2 signature and are a later pass; drawing
 * the QR image is the PDF slice's job. Pure, no I/O.
 */

export interface Phase1QrInput {
  readonly sellerName: string;
  readonly vatNumber: string;
  readonly timestamp: Date;
  /** Decimal string with two places, e.g. `1150.00`. */
  readonly totalWithVat: string;
  /** Decimal string with two places, e.g. `150.00`. */
  readonly vatAmount: string;
}

const MAX_VALUE = 255;
const AMOUNT = /^-?\d{1,15}\.\d{2}$/u;

/** Cut to ≤ `max` bytes without splitting a UTF-8 sequence. */
function cutUtf8(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.slice(0, end);
}

/** ISO 8601 UTC without milliseconds: `YYYY-MM-DDTHH:mm:ssZ`. */
export function zatcaTimestamp(at: Date): string {
  if (Number.isNaN(at.getTime())) throw new RangeError('timestamp is not a valid date');
  return `${at.toISOString().slice(0, 19)}Z`;
}

/** One TLV field: tag byte, length byte, value (≤ 255 bytes). Shared with the Phase-2 QR. */
export function tlvField(tag: number, value: Uint8Array): number[] {
  if (value.length > MAX_VALUE) throw new RangeError(`tag ${tag} is longer than 255 bytes`);
  return [tag, value.length, ...value];
}

export function phase1Qr(input: Phase1QrInput): string {
  for (const [name, amount] of [
    ['totalWithVat', input.totalWithVat],
    ['vatAmount', input.vatAmount],
  ] as const) {
    if (!AMOUNT.test(amount)) throw new RangeError(`${name} must be a decimal with two places`);
  }
  const bytes = [
    ...tlvField(1, cutUtf8(utf8(input.sellerName.trim()), MAX_VALUE)),
    ...tlvField(2, utf8(input.vatNumber)),
    ...tlvField(3, utf8(zatcaTimestamp(input.timestamp))),
    ...tlvField(4, utf8(input.totalWithVat)),
    ...tlvField(5, utf8(input.vatAmount)),
  ];
  return toBase64(Uint8Array.from(bytes));
}

export interface TlvField {
  readonly tag: number;
  readonly length: number;
  readonly value: string;
}

/** Decodes a TLV payload (tests and diagnostics). */
export function decodeTlv(payload: string): readonly TlvField[] {
  const bytes = fromBase64(payload);
  const out: TlvField[] = [];
  let i = 0;
  while (i < bytes.length) {
    const tag = bytes[i] ?? 0;
    const length = bytes[i + 1] ?? 0;
    if (i + 2 + length > bytes.length) throw new RangeError('truncated TLV payload');
    out.push({ tag, length, value: fromUtf8(bytes.slice(i + 2, i + 2 + length)) });
    i += 2 + length;
  }
  return out;
}
