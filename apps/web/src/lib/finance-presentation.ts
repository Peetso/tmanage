import { currencyDigits } from '@tmanage/domain';
import type { CapsuleState } from '@tmanage/ui';
import { ApiRequestError } from './api/errors';

/**
 * A10a — the pure half of the finance screens part 1: who may decide on an expense or a
 * timesheet, the self-approval refusal, amount parsing and week navigation. No I/O here.
 */

/** The currencies the finance API accepts (`FINANCE_CURRENCIES` in the API). */
export const EXPENSE_CURRENCIES = [
  'SAR',
  'AED',
  'EGP',
  'QAR',
  'USD',
  'EUR',
  'GBP',
  'MAD',
  'TRY',
  'INR',
  'CAD',
  'AUD',
  'CHF',
  'KWD',
  'BHD',
  'OMR',
  'JOD',
  'TND',
  'IQD',
  'JPY',
] as const;

/**
 * Approve / Reject are offered only to an approver, only on a submitted record, and never on the
 * member's own record (B20): the API refuses that with 403 `cannot_approve_own`, so the button
 * would only lead to an error.
 */
export function mayDecide(
  ownerMembershipId: string,
  myMembershipId: string | undefined,
  canApprove: boolean,
  state: string,
): boolean {
  if (!canApprove || myMembershipId === undefined) return false;
  return state === 'submitted' && ownerMembershipId !== myMembershipId;
}

/** True when the API refused a decision because the record is the caller's own. */
export function isCannotApproveOwn(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.details.some((detail) => detail.message === 'cannot_approve_own')
  );
}

/** `"1,250.5"` in SAR → 125050 minor units; `null` when not a positive amount for the currency. */
export function parseAmountToMinor(text: string, currency: string): number | null {
  const cleaned = text.replace(/[,\s]/gu, '');
  let digits: number;
  try {
    digits = currencyDigits(currency);
  } catch {
    return null;
  }
  const pattern =
    digits === 0 ? /^\d{1,13}$/u : new RegExp(`^\\d{1,13}(\\.\\d{1,${digits}})?$`, 'u');
  if (!pattern.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  const minor = Number(whole + fraction.padEnd(digits, '0'));
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

export function stateCapsule(state: string): CapsuleState {
  switch (state) {
    case 'submitted':
      return 'waiting';
    case 'approved':
    case 'invoiced':
      return 'done';
    case 'rejected':
    case 'changes_requested':
      return 'blocked';
    case 'locked':
      return 'archived';
    case 'open':
      return 'current';
    default:
      return 'neutral';
  }
}

/** `150` → `2h 30m`. */
export function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/** The ISO week (`2026-W45`) `deltaWeeks` away from the week that starts on `periodStart`. */
export function isoWeekFrom(periodStart: string, deltaWeeks: number): string {
  const date = new Date(`${periodStart}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaWeeks * 7 + 3);
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const year = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}
