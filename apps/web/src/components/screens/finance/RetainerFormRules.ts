import { minorAsText, parseAmountMinor } from './InvoiceFormRules';
import type { RetainerBody, RetainerRow } from './RetainerApi';

/**
 * 52-06 — the pure half of the retainer form: the typed text, and the body the API takes. The API
 * re-checks every rule (`validateRetainer` / `validateRetainerPatch`); these mirror them so the
 * form names the field before the round trip. Period and start date are fixed after creation.
 */

export const RETAINER_PERIODS = ['monthly', 'quarterly'] as const;
export const ROLLOVER_RULES = ['none', 'cap', 'unlimited'] as const;
export const BILLING_TIMINGS = ['advance', 'arrears'] as const;
const MAX_HOURS = 10_000;

export interface RetainerDraft {
  readonly name: string;
  readonly period: string;
  readonly hours: string;
  readonly amount: string;
  readonly rollover: string;
  readonly capHours: string;
  readonly billingTiming: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly clientVisible: boolean;
}

export type RetainerField = 'name' | 'hours' | 'amount' | 'capHours' | 'endsOn' | 'startsOn';

/** A new retainer starts on the first day of next month. */
export function newRetainerDraft(today: Date): RetainerDraft {
  const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  return {
    name: '',
    period: 'monthly',
    hours: '',
    amount: '',
    rollover: 'none',
    capHours: '',
    billingTiming: 'advance',
    startsOn: next.toISOString().slice(0, 10),
    endsOn: '',
    clientVisible: true,
  };
}

export function retainerToDraft(row: RetainerRow, currency: string): RetainerDraft {
  return {
    name: row.name,
    period: row.period,
    hours: row.hoursPerPeriod === null ? '' : String(row.hoursPerPeriod),
    amount: row.amountPerPeriodMinor == null ? '' : minorAsText(row.amountPerPeriodMinor, currency),
    rollover: row.rollover,
    capHours: row.rolloverCapMinutes == null ? '' : String(Math.round(row.rolloverCapMinutes / 60)),
    billingTiming: row.billingTiming,
    startsOn: row.startsOn,
    endsOn: row.endsOn ?? '',
    clientVisible: row.clientVisible,
  };
}

function wholeHours(text: string): number | null | undefined {
  const clean = text.trim();
  if (clean === '') return null;
  if (!/^\d{1,5}$/u.test(clean)) return undefined;
  return Number(clean);
}

/**
 * The create (`mode: 'create'`) or edit body, or the field to fix. Hours and/or an amount are
 * required; a rollover needs hours; a capped rollover needs its cap; the end is not before the
 * start. An edit never sends period or start date.
 */
export function retainerDraftToBody(
  draft: RetainerDraft,
  currency: string,
  mode: 'create' | 'edit',
):
  | { readonly ok: true; readonly body: RetainerBody }
  | { readonly ok: false; readonly field: RetainerField } {
  const name = draft.name.trim();
  if (name.length < 1 || name.length > 120) return { ok: false, field: 'name' };
  const hours = wholeHours(draft.hours);
  if (hours === undefined || (hours !== null && (hours < 1 || hours > MAX_HOURS))) {
    return { ok: false, field: 'hours' };
  }
  let amount: number | null = null;
  if (draft.amount.trim() !== '') {
    amount = parseAmountMinor(draft.amount, currency);
    if (amount === null) return { ok: false, field: 'amount' };
  }
  if (hours === null && amount === null) return { ok: false, field: 'hours' };
  if (draft.rollover !== 'none' && hours === null) return { ok: false, field: 'hours' };
  let capMinutes: number | null = null;
  if (draft.rollover === 'cap') {
    const cap = wholeHours(draft.capHours);
    if (cap === undefined || cap === null || cap > MAX_HOURS)
      return { ok: false, field: 'capHours' };
    capMinutes = cap * 60;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(draft.startsOn)) return { ok: false, field: 'startsOn' };
  const endsOn = draft.endsOn.trim() === '' ? null : draft.endsOn;
  if (endsOn !== null && (!/^\d{4}-\d{2}-\d{2}$/u.test(endsOn) || endsOn < draft.startsOn)) {
    return { ok: false, field: 'endsOn' };
  }
  const common = {
    name,
    hoursPerPeriod: hours,
    amountPerPeriodMinor: amount,
    rollover: draft.rollover,
    rolloverCapMinutes: capMinutes,
    endsOn,
    clientVisible: draft.clientVisible,
  };
  return {
    ok: true,
    body:
      mode === 'create'
        ? {
            ...common,
            period: draft.period,
            billingTiming: draft.billingTiming,
            startsOn: draft.startsOn,
          }
        : common,
  };
}
