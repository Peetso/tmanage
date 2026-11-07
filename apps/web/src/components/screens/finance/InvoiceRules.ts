import type { CapsuleState } from '@tmanage/ui';
import type { AgingBucketKey } from './InvoiceApi';

/** The invoice state filters the list offers, in the order of the design (R31 L02 Figma section). */
export const INVOICE_FILTERS = ['all', 'draft', 'sent', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceFilter = (typeof INVOICE_FILTERS)[number];

/**
 * The capsule for a client invoice. An overdue invoice reads as blocked whatever its stored state,
 * because the money is late; paid is done; sent and part-paid wait on the client; void and credited
 * are archived; a draft is neutral.
 */
export function invoiceCapsule(state: string, overdue: boolean): CapsuleState {
  if (overdue && (state === 'sent' || state === 'partially_paid')) return 'blocked';
  if (state === 'paid') return 'done';
  if (state === 'sent' || state === 'partially_paid') return 'waiting';
  if (state === 'void' || state === 'credited') return 'archived';
  return 'neutral';
}

/** The catalog key suffix for the capsule word: overdue wins over the stored state, as above. */
export function invoiceStateKey(state: string, overdue: boolean): string {
  if (overdue && (state === 'sent' || state === 'partially_paid')) return 'overdue';
  return state;
}

/** Minutes as hours with at most one decimal, for retainer allowances ("12.5"). */
export function minutesAsHours(minutes: number): string {
  return String(Math.round((minutes / 60) * 10) / 10);
}

/** The aging bucket labels: catalog key and the English shown until the key is merged. */
export const AGING_WORDS: Record<AgingBucketKey, readonly [string, string]> = {
  '0_30': ['FinanceReport.bucket0to30', '0–30 days'],
  '31_60': ['FinanceReport.bucket31to60', '31–60 days'],
  '61_90': ['FinanceReport.bucket61to90', '61–90 days'],
  '90_plus': ['FinanceReport.bucket90plus', '90+ days'],
};
