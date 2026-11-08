import { describe, expect, it } from 'vitest';
import {
  emptyLine,
  linesToBody,
  parseAmountMinor,
  parseRecipients,
  previewInvoiceTotals,
  previewPayment,
} from '../src/components/screens/finance/InvoiceFormRules';
import {
  retainerDraftToBody,
  newRetainerDraft,
} from '../src/components/screens/finance/RetainerFormRules';

const line = (quantity: string, unitPrice: string, taxPercent: string) => ({
  ...emptyLine('item', taxPercent),
  description: 'Design work',
  quantity,
  unitPrice,
});

describe('R35 L6-52-09 invoice totals', () => {
  it('sums rounded lines per tax rate, in minor units', () => {
    const totals = previewInvoiceTotals(
      [line('12', '450', '15'), line('1', '800', '15'), line('1.5', '33.33', '0')],
      'SAR',
    );
    // 5400.00 + 800.00 + 49.995→50.00 (half-up) = 6250.00; tax 15 % of 6200.00 = 930.00
    expect(totals.subtotalMinor).toBe(625_000);
    expect(totals.taxMinor).toBe(93_000);
    expect(totals.totalMinor).toBe(718_000);
    expect(totals.taxByRate.map((rate) => rate.taxBp)).toEqual([0, 1500]);
  });

  it('respects the currency digits and refuses a line it cannot send', () => {
    expect(parseAmountMinor('1,250.5', 'SAR')).toBe(125_050);
    expect(parseAmountMinor('1.234', 'KWD')).toBe(1234);
    expect(parseAmountMinor('12.5', 'JPY')).toBeNull();
    expect(linesToBody([line('0', '10', '15')], 'SAR', false)).toEqual({
      ok: false,
      problem: { index: 0, field: 'quantity' },
    });
    const ok = linesToBody([line('2', '10.5', '15')], 'SAR', true);
    expect(ok.ok && ok.lines[0]).toMatchObject({
      descriptionAr: 'Design work',
      descriptionEn: null,
      quantity: 2,
      unitPriceMinor: 1050,
      taxBp: 1500,
    });
  });
});

describe('R35 L6-52-09 payment status rule', () => {
  const invoice = {
    state: 'sent',
    totalMinor: 1_058_000,
    paidMinor: 0,
    depositAppliedMinor: 0,
    currency: 'SAR',
  };

  it('moves sent → part paid → paid and refuses an overpayment', () => {
    expect(previewPayment(invoice, '5000')).toEqual({
      ok: true,
      state: 'partially_paid',
      remainingMinor: 558_000,
    });
    expect(
      previewPayment({ ...invoice, state: 'partially_paid', paidMinor: 500_000 }, '5580'),
    ).toEqual({
      ok: true,
      state: 'paid',
      remainingMinor: 0,
    });
    expect(previewPayment(invoice, '10580.01')).toEqual({ ok: false, error: 'overpayment' });
    expect(previewPayment({ ...invoice, state: 'draft' }, '1')).toEqual({
      ok: false,
      error: 'invalid_state',
    });
  });

  it('reads recipients as unique addresses', () => {
    expect(parseRecipients('Billing@alnoor.sa, billing@alnoor.sa; ap@alnoor.sa')).toEqual([
      'billing@alnoor.sa',
      'ap@alnoor.sa',
    ]);
    expect(parseRecipients('not-an-address')).toBeNull();
  });
});

describe('R35 L6-52-09 retainer form', () => {
  it('needs hours for a rollover and a cap for a capped one; an edit omits fixed terms', () => {
    const base = { ...newRetainerDraft(new Date('2026-11-08T00:00:00Z')), name: 'Brand care' };
    expect(base.startsOn).toBe('2026-12-01');
    expect(
      retainerDraftToBody({ ...base, amount: '18000', rollover: 'cap' }, 'SAR', 'create'),
    ).toEqual({
      ok: false,
      field: 'hours',
    });
    expect(retainerDraftToBody({ ...base, hours: '40', rollover: 'cap' }, 'SAR', 'create')).toEqual(
      {
        ok: false,
        field: 'capHours',
      },
    );
    const edit = retainerDraftToBody(
      { ...base, hours: '40', rollover: 'cap', capHours: '10' },
      'SAR',
      'edit',
    );
    expect(edit.ok && edit.body).toEqual({
      name: 'Brand care',
      hoursPerPeriod: 40,
      amountPerPeriodMinor: null,
      rollover: 'cap',
      rolloverCapMinutes: 600,
      endsOn: null,
      clientVisible: true,
    });
  });
});
