import { describe, expect, it } from 'vitest';
import { amountInWords } from './amount-in-words.js';
import {
  agingBucket,
  applyPayment,
  creditNoteTotals,
  invoiceStanding,
  invoiceTotals,
  nextInvoiceState,
} from './invoicing.js';

describe('52-13 invoiceStanding', () => {
  it('reads paid, overdue, due and open from the due date and what is left to pay', () => {
    expect(invoiceStanding('2026-11-13', 0, '2026-11-16')).toEqual({ kind: 'paid' });
    expect(invoiceStanding('2026-11-13', 4_560_000, '2026-11-16')).toEqual({
      kind: 'overdue',
      days: 3,
    });
    expect(invoiceStanding('2026-11-30', 100, '2026-11-16')).toEqual({ kind: 'due', days: 14 });
    expect(invoiceStanding('2026-11-16', 100, '2026-11-16')).toEqual({ kind: 'due', days: 0 });
    expect(invoiceStanding(null, 100, '2026-11-16')).toEqual({ kind: 'open' });
  });
});

/** UNIT-52-12 invoice totals, discount, tax per rate, deposit, payments, credit; UNIT-52-13 words. */

describe('UNIT-52-12 invoice maths', () => {
  it('discounts and taxes per line, sums per rate, and nets the deposit off the amount due', () => {
    const totals = invoiceTotals(
      [
        { quantityCenti: 1050, unitPriceMinor: 30_000, discountBp: 1000, taxBp: 1500 },
        { quantityCenti: 100, unitPriceMinor: 12_345, taxBp: 0 },
      ],
      { depositAppliedMinor: 50_000, paidMinor: 100_000 },
    );
    // 10.5 h × 300.00 = 3150.00; 10 % off = 315.00; tax 15 % of 2835.00 = 425.25.
    expect(totals.lines[0]).toEqual({
      lineGrossBeforeDiscountMinor: 315_000,
      lineDiscountMinor: 31_500,
      lineNetMinor: 283_500,
      lineTaxMinor: 42_525,
      lineGrossMinor: 326_025,
    });
    expect(totals).toMatchObject({
      subtotalMinor: 327_345,
      discountMinor: 31_500,
      taxMinor: 42_525,
      totalMinor: 338_370,
      amountDueMinor: 188_370,
    });
    expect(totals.taxByRate).toEqual([
      { taxBp: 0, netMinor: 12_345, taxMinor: 0 },
      { taxBp: 1500, netMinor: 283_500, taxMinor: 42_525 },
    ]);
  });

  it('moves sent → partially_paid → paid and refuses an overpayment unless allowed', () => {
    const sent = {
      state: 'sent',
      totalMinor: 10_000,
      paidMinor: 0,
      depositAppliedMinor: 2_000,
    } as const;
    expect(applyPayment(sent, 3_000, false)).toEqual({
      ok: true,
      state: 'partially_paid',
      paidMinor: 3_000,
    });
    expect(applyPayment(sent, 8_000, false)).toEqual({ ok: true, state: 'paid', paidMinor: 8_000 });
    expect(applyPayment(sent, 8_001, false)).toEqual({ ok: false, error: 'overpayment' });
    expect(applyPayment(sent, 8_001, true)).toMatchObject({ ok: true, state: 'paid' });
    expect(applyPayment({ ...sent, state: 'draft' }, 1, false)).toEqual({
      ok: false,
      error: 'invalid_state',
    });
    expect(nextInvoiceState('sent', 'void')).toBeNull();
    expect(nextInvoiceState('paid', 'credit_full')).toBe('credited');
  });

  it('buckets by days past due and caps a credit at the invoice total', () => {
    expect(agingBucket('2026-10-31', '2026-10-01')).toBe('0_30');
    expect(agingBucket('2026-09-01', '2026-10-02')).toBe('31_60');
    expect(agingBucket('2026-07-01', '2026-09-28')).toBe('61_90');
    expect(agingBucket('2026-01-01', '2026-11-01')).toBe('90_plus');
    const credit = creditNoteTotals(
      [{ quantityCenti: 100, unitPriceMinor: 1_000, taxBp: 1500 }],
      2_300,
      1_000,
    );
    expect(credit).toMatchObject({ subtotalMinor: 1_000, taxMinor: 150, totalMinor: 1_150 });
    expect(() =>
      creditNoteTotals([{ quantityCenti: 100, unitPriceMinor: 1_000, taxBp: 1500 }], 2_000, 1_000),
    ).toThrow();
  });
});

describe('UNIT-52-13 amount in words', () => {
  it('spells Arabic with the «فقط … لا غير» frame and English with the minor unit', () => {
    expect(amountInWords(800_000, 'SAR', 'ar')).toBe('فقط ثمانية آلاف ريال سعودي لا غير');
    expect(amountInWords(1_225_050, 'AED', 'ar')).toBe(
      'فقط اثنا عشر ألف ومئتان وخمسون درهم إماراتي وخمسون فلس لا غير',
    );
    expect(amountInWords(800_050, 'SAR', 'en')).toBe(
      'Eight thousand Saudi riyals and fifty halalas only',
    );
    expect(amountInWords(100, 'USD', 'en')).toBe('One US dollar only');
    expect(amountInWords(2_105_001, 'EGP', 'en')).toBe(
      'Twenty-one thousand fifty Egyptian pounds and one piastre only',
    );
  });
});
