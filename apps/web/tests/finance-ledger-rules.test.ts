import { describe, expect, it } from 'vitest';
import { invoiceCapsule, invoiceStateKey } from '../src/components/screens/finance/InvoiceRules';
import {
  isReopenReasonValid,
  monthWindow,
} from '../src/components/screens/finance/PeriodLockRules';

/** A10b: the rules the finance ledger screens apply before calling the API. */
describe('period lock month window', () => {
  it('turns a month into the whole-month window the API accepts, leap years included', () => {
    expect(monthWindow('2028-02')).toEqual({ periodStart: '2028-02-01', periodEnd: '2028-02-29' });
    expect(monthWindow('2026-11')).toEqual({ periodStart: '2026-11-01', periodEnd: '2026-11-30' });
  });

  it('refuses anything that is not a month', () => {
    expect(monthWindow('')).toBeNull();
    expect(monthWindow('2026-13')).toBeNull();
    expect(monthWindow('2026-11-01')).toBeNull();
  });

  it('asks for a 3 to 500 character reason to reopen', () => {
    expect(isReopenReasonValid('  ab ')).toBe(false);
    expect(isReopenReasonValid('Late supplier bill')).toBe(true);
    expect(isReopenReasonValid('x'.repeat(501))).toBe(false);
  });
});

describe('invoice state capsule', () => {
  it('shows a late sent or part-paid invoice as overdue, never a paid one', () => {
    expect(invoiceCapsule('sent', true)).toBe('blocked');
    expect(invoiceStateKey('partially_paid', true)).toBe('overdue');
    expect(invoiceCapsule('paid', true)).toBe('done');
    expect(invoiceStateKey('paid', true)).toBe('paid');
    expect(invoiceCapsule('void', false)).toBe('archived');
    expect(invoiceCapsule('draft', false)).toBe('neutral');
  });
});
