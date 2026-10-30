import { describe, expect, it } from 'vitest';
import { computeLineTax, formatMoney, lineNetFromQuantity, parseMoney, sumLines } from './money.js';

describe('52-23 money', () => {
  it('parses decimal text half-up at each currency minor unit (0.005 edges)', () => {
    const cases: [string, string, number][] = [
      ['0.005', 'USD', 1],
      ['0.0049', 'EUR', 0],
      ['10.005', 'SAR', 1001],
      ['-0.005', 'AED', -1],
      ['1.0005', 'KWD', 1001],
      ['99.994', 'EGP', 9999],
    ];
    for (const [text, currency, minor] of cases) {
      expect(parseMoney(text, currency).amountMinor, `${text} ${currency}`).toBe(minor);
    }
    expect(() => parseMoney('1.5', 'XXX')).toThrow();
  });

  it('rounds tax per line, then sums the rounded lines', () => {
    const lines = [
      computeLineTax(333, 1500),
      computeLineTax(333, 1500),
      computeLineTax(-333, 1500),
    ];
    expect(lines[0]).toEqual({ lineNetMinor: 333, lineTaxMinor: 50, lineGrossMinor: 383 });
    expect(lines[2]?.lineTaxMinor).toBe(-50);
    expect(sumLines(lines)).toEqual({ netMinor: 333, taxMinor: 50, grossMinor: 383 });
    expect(lineNetFromQuantity(150, 333)).toBe(500);
    expect(() => computeLineTax(100, 10_001)).toThrow();
  });

  it('formats Eastern Arabic digits only when asked', () => {
    const value = { amountMinor: 123456, currency: 'SAR' };
    expect(formatMoney(value, 'ar-SA', 'arab')).toMatch(/[١٢٣٤٥٦]/u);
    expect(formatMoney(value, 'ar-SA', 'latn')).toMatch(/1,?234[.,٫]56/u);
    expect(formatMoney({ amountMinor: 1000, currency: 'KWD' }, 'en')).toContain('1.000');
  });
});
