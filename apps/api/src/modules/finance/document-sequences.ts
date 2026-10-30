import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { NumberingReset } from './finance-rules.js';

/**
 * 52-23 — gapless document numbers (spec 52 §4 `org_document_sequences`).
 *
 * `nextNumber(tx, organizationId, kind, issuedAt)` runs INSIDE the caller's issuing transaction:
 * it makes sure the counter row for (organization, kind, period) exists, locks it FOR UPDATE,
 * takes `next_value` and advances it. A second issuer waits on the row lock until the first
 * commits, and a rolled-back issue rolls the counter back with it — so the numbers have no gaps
 * and never repeat. The period is the calendar year **in the organization's time zone**
 * (`'0000'` when the profile never resets), so the counter starts again at 1 on 1 January local.
 */

export const DOCUMENT_KINDS = ['invoice', 'quote', 'credit_note'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The never-reset period key. */
export const NEVER_PERIOD = '0000';

/** The year of `at` in `timeZone` (an IANA zone; an unknown zone falls back to UTC). */
export function periodKeyFor(at: Date, timeZone: string, reset: NumberingReset): string {
  if (reset === 'never') return NEVER_PERIOD;
  let year: string | undefined;
  try {
    year = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' })
      .formatToParts(at)
      .find((part) => part.type === 'year')?.value;
  } catch {
    year = undefined;
  }
  return year ?? String(at.getUTCFullYear());
}

/** `INV-2026-0001`, or `INV-0001` for a never-reset counter. */
export function formatDocumentNumber(prefix: string, periodKey: string, value: number): string {
  const counter = String(value).padStart(4, '0');
  return periodKey === NEVER_PERIOD ? `${prefix}-${counter}` : `${prefix}-${periodKey}-${counter}`;
}

/** What the sequence needs from the profile and the organization. */
export interface NumberingSettings {
  readonly prefix: string;
  readonly reset: NumberingReset;
  readonly timeZone: string;
}

/** The storage port. `lockAndTake` must lock the row FOR UPDATE and advance it in one step. */
export interface DocumentSequenceStore {
  settings(
    tx: TenantQueryRunner,
    organizationId: string,
    kind: DocumentKind,
  ): Promise<NumberingSettings>;
  ensure(
    tx: TenantQueryRunner,
    organizationId: string,
    kind: DocumentKind,
    periodKey: string,
    at: Date,
  ): Promise<void>;
  lockAndTake(
    tx: TenantQueryRunner,
    organizationId: string,
    kind: DocumentKind,
    periodKey: string,
    at: Date,
  ): Promise<number>;
}

export interface IssuedNumber {
  readonly kind: DocumentKind;
  readonly periodKey: string;
  readonly value: number;
  readonly number: string;
}

export class DocumentSequenceService {
  constructor(private readonly store: DocumentSequenceStore) {}

  async nextNumber(
    tx: TenantQueryRunner,
    organizationId: string,
    kind: DocumentKind,
    issuedAt: Date,
  ): Promise<IssuedNumber> {
    const settings = await this.store.settings(tx, organizationId, kind);
    const periodKey = periodKeyFor(issuedAt, settings.timeZone, settings.reset);
    await this.store.ensure(tx, organizationId, kind, periodKey, issuedAt);
    const value = await this.store.lockAndTake(tx, organizationId, kind, periodKey, issuedAt);
    return {
      kind,
      periodKey,
      value,
      number: formatDocumentNumber(settings.prefix, periodKey, value),
    };
  }
}
