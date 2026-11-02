import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GENESIS_PIH,
  chainCheckDue,
  runEinvoiceChainReconcile,
  verifyChain,
} from './einvoice-chain-reconciler.js';
import type {
  ChainBreakSignal,
  ChainLink,
  EinvoiceChainCheck,
  EinvoiceChainStore,
} from './einvoice-chain-reconciler.js';

const hashOf = (n: number): string =>
  createHash('sha256')
    .update(`doc-${String(n)}`)
    .digest('hex');

/** 100 invoices + 10 credit notes interleaved (every 11th a credit note), correctly linked. */
function chain(length = 110): ChainLink[] {
  return Array.from({ length }, (_, i) => ({
    icv: i + 1,
    pih: i === 0 ? GENESIS_PIH : hashOf(i),
    xmlHash: hashOf(i + 1),
    kind: (i + 1) % 11 === 0 ? ('credit_note' as const) : ('invoice' as const),
    id: `d${String(i + 1)}`,
  }));
}

describe('52-12 e-invoice chain reconciler', () => {
  it('pins the genesis PIH to the API literal', () => {
    expect(GENESIS_PIH).toBe('5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9');
  });

  it('passes 100 invoices + 10 credit notes and reports each break where it occurs', () => {
    const ok = verifyChain([...chain()].reverse());
    expect(ok).toMatchObject({ status: 'ok', headIcv: 110, documents: 110, creditNotes: 10 });
    expect(verifyChain([])).toMatchObject({ status: 'empty', headIcv: null, documents: 0 });

    const gap = chain(4).filter((link) => link.icv !== 3);
    expect(verifyChain(gap)).toMatchObject({ status: 'broken', breakIcv: 4, reason: 'gap' });

    const edited = chain().map((l) => (l.icv === 50 ? { ...l, xmlHash: hashOf(999) } : l));
    expect(verifyChain(edited)).toMatchObject({ breakIcv: 51, reason: 'pih_mismatch' });

    const genesis = chain(3).map((l) => (l.icv === 1 ? { ...l, pih: hashOf(0) } : l));
    expect(verifyChain(genesis)).toMatchObject({ breakIcv: 1, reason: 'genesis_mismatch' });

    const dup = chain(3);
    dup[2] = { ...dup[2]!, xmlHash: hashOf(1) };
    expect(verifyChain(dup)).toMatchObject({ breakIcv: 3, reason: 'duplicate_hash' });
  });

  it('writes one verdict per organization, signals only the broken one, prunes at 90 days', async () => {
    const checks: EinvoiceChainCheck[] = [];
    const signals: ChainBreakSignal[] = [];
    const prunes: Date[] = [];
    const now = new Date('2026-11-02T03:05:00Z');
    const store: EinvoiceChainStore = {
      latestCheckedAt: () => Promise.resolve(null),
      zatcaOrganizations: () => Promise.resolve(['o-ok', 'o-broken', 'o-empty']),
      chainLinks: (org) =>
        Promise.resolve(org === 'o-ok' ? chain() : org === 'o-broken' ? chain(4).slice(1) : []),
      insertCheck: (check) => (checks.push(check), Promise.resolve()),
      recordBreak: (signal) => (signals.push(signal), Promise.resolve()),
      pruneBefore: (before) => (prunes.push(before), Promise.resolve(2)),
    };
    const result = await runEinvoiceChainReconcile({ store, now: () => now });
    expect(result).toEqual({
      organizations: 3,
      ok: 1,
      broken: 1,
      empty: 1,
      failed: 0,
      pruned: 2,
    });
    expect(checks.map((c) => [c.organizationId, c.status])).toEqual([
      ['o-ok', 'ok'],
      ['o-broken', 'broken'],
      ['o-empty', 'empty'],
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      organizationId: 'o-broken',
      ruleKey: 'einvoice_chain_break',
      severity: 'high',
      count: 1,
      breakIcv: 2,
      reason: 'gap',
    });
    expect(signals[0]!.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prunes).toEqual([new Date('2026-08-04T03:05:00Z')]);
  });

  it('is due after 26 h at 03:05 UTC, not 20 h later at 02:00', () => {
    const at0305 = new Date('2026-11-02T03:05:00Z');
    expect(chainCheckDue(new Date(at0305.getTime() - 26.5 * 3_600_000), at0305)).toBe(true);
    const at0200 = new Date('2026-11-02T02:00:00Z');
    expect(chainCheckDue(new Date(at0200.getTime() - 20 * 3_600_000), at0200)).toBe(false);
    expect(chainCheckDue(null, at0200)).toBe(true);
  });
});
