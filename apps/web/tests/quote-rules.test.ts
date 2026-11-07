import { describe, expect, it } from 'vitest';
import {
  EMPTY_LINE,
  draftToInput,
  newDraft,
  parseMinor,
  parseTaxBp,
  previewTotals,
  quoteCapsule,
  quoteLinkUrl,
} from '../src/components/screens/quotes/QuoteRules';

/** A12: the rules the quote screens apply before calling the API. */
describe('quote money parsing', () => {
  it('turns typed amounts into integer minor units, never a float', () => {
    expect(parseMinor('1,250.5')).toBe(125050);
    expect(parseMinor('0.07')).toBe(7);
    expect(parseMinor('12')).toBe(1200);
    expect(parseMinor('1.005')).toBeNull();
    expect(parseMinor('-3')).toBeNull();
    expect(parseMinor('abc')).toBeNull();
  });

  it('takes a tax rate from 0 to 100 % as basis points', () => {
    expect(parseTaxBp('14')).toBe(1400);
    expect(parseTaxBp('7.5')).toBe(750);
    expect(parseTaxBp('')).toBe(0);
    expect(parseTaxBp('100.01')).toBeNull();
  });
});

describe('quote totals preview', () => {
  it('rounds half-up per line exactly as the server does', () => {
    const totals = previewTotals([
      { description: 'a', unit: 'hour', quantity: '1.5', unitPrice: '0.33', taxPercent: '14' },
      { description: 'b', unit: 'day', quantity: '2', unitPrice: '6000', taxPercent: '0' },
    ]);
    // 1.5 × 33 = 49.5 → 50; tax 50 × 14 % = 7; 2 × 600 000 = 1 200 000.
    expect(totals).toEqual({ subtotalMinor: 1_200_050, taxMinor: 7, totalMinor: 1_200_057 });
  });
});

describe('quote draft to request body', () => {
  const base = { ...newDraft(new Date('2026-11-08T10:00:00Z')), title: 'Site', leadName: 'Ola' };

  it('defaults validity to 30 days and sends no totals', () => {
    expect(base.validUntil).toBe('2026-12-08');
    const result = draftToInput(
      { ...base, lines: [{ ...EMPTY_LINE, description: 'x', unitPrice: '10' }] },
      3,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.lines[0]).toEqual({
        description: 'x',
        unit: 'item',
        quantity: 1,
        unitPriceMinor: 1000,
        taxBp: 0,
      });
      expect(result.input.version).toBe(3);
      expect(result.input).not.toHaveProperty('totalMinor');
    }
  });

  it('names the first problem: a client or lead, then a bad line', () => {
    expect(draftToInput({ ...base, leadName: '' }, null)).toEqual({ ok: false, problem: 'client' });
    expect(
      draftToInput(
        { ...base, lines: [{ ...EMPTY_LINE, description: 'x', unitPrice: '1.234' }] },
        null,
      ),
    ).toEqual({
      ok: false,
      problem: { line: 0, field: 'unitPrice' },
    });
  });
});

describe('quote presentation', () => {
  it('maps states to capsules and builds the client link on this origin', () => {
    expect(quoteCapsule('accepted')).toBe('done');
    expect(quoteCapsule('sent')).toBe('waiting');
    expect(quoteCapsule('declined')).toBe('blocked');
    expect(quoteLinkUrl('https://tmanage.peetrix.com', 'a/b')).toBe(
      'https://tmanage.peetrix.com/q/a%2Fb',
    );
  });
});
