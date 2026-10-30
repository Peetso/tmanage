import { describe, expect, it, vi } from 'vitest';
import type { PublicLinkRow, QuoteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { computeTotals, contentHash, validateQuote } from './quote-content.js';
import { quoteTarget } from './quote-target.js';

const now = new Date('2026-10-30T10:00:00.000Z');
const runner = {} as TenantQueryRunner;
const context = { organizationId: 'org-1' } as TenantContext;
const quote = {
  id: 'q-1',
  number: 'Q-0001',
  title: 'Website',
  currency: 'USD',
  language: 'en',
  clientOrganizationId: null,
  leadName: 'Lead',
  leadEmail: null,
  validUntil: new Date('2026-11-30T23:59:59.999Z'),
  termsText: null,
  subtotalMinor: 100,
  taxMinor: 0,
  totalMinor: 100,
  status: 'sent',
  contentHash: 'h'.repeat(64),
} as QuoteRow;

describe('52-08 quotes', () => {
  it('computes totals on the server in exact half-up minor units', () => {
    const t = computeTotals([
      { description: 'a', unit: 'hour', quantityCenti: 150, unitPriceMinor: 333, taxBp: 1400 },
      { description: 'b', unit: 'item', quantityCenti: 100, unitPriceMinor: 999_999_999, taxBp: 0 },
    ]);
    expect(t.lines.map((l) => [l.lineNetMinor, l.lineTaxMinor])).toEqual([
      [500, 70],
      [999_999_999, 0],
    ]);
    expect(t.totalMinor).toBe(500 + 70 + 999_999_999);
  });

  it('refuses a quantity with more than two decimals and needs a client or lead', () => {
    const base = { title: 'x', currency: 'USD', leadName: 'L' };
    const line = { description: 'd', unitPriceMinor: 1 };
    expect(() => validateQuote({ ...base, lines: [{ ...line, quantity: 1.005 }] }, now)).toThrow();
    expect(() => validateQuote({ title: 'x', currency: 'USD', lines: [line] }, now)).toThrow();
  });

  it('binds a content hash that changes with any accepted content', () => {
    expect(contentHash(quote, [])).toBe(contentHash({ ...quote }, []));
    expect(contentHash({ ...quote, totalMinor: 101 }, [])).not.toBe(contentHash(quote, []));
  });

  it('reaches only a sent, unexpired quote and moves it on the link decision', async () => {
    const repository = {
      find: vi.fn().mockResolvedValue(quote),
      lines: vi.fn().mockResolvedValue([]),
      decide: vi.fn().mockResolvedValue(true),
    };
    const audit = { record: vi.fn() };
    const target = quoteTarget({ repository, audit, now: () => now });
    expect(target.decisionsRequiringCode).toEqual(['accept']);
    expect((await target.resolve(runner, context, 'q-1'))?.versionHash).toBe(quote.contentHash);
    repository.find.mockResolvedValueOnce({ ...quote, status: 'draft' });
    expect(await target.resolve(runner, context, 'q-1')).toBeNull();
    const link = { id: 'l-1', targetId: 'q-1', versionHash: quote.contentHash } as PublicLinkRow;
    await target.onDecision?.(runner, context, link, 'accept');
    expect(repository.decide).toHaveBeenCalledWith(
      runner,
      context,
      'q-1',
      quote.contentHash,
      'accepted',
      now,
    );
    repository.decide.mockResolvedValueOnce(false);
    await expect(target.onDecision?.(runner, context, link, 'decline')).rejects.toThrow();
  });
});
