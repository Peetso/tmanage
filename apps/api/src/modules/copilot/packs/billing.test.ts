import { describe, expect, it } from 'vitest';
import { findOpById, sensitivityOf } from '../../ai-actions/registry/index.js';
import { allDetailsById } from '../../mcp/tool-catalog.js';
import { guardAnswer } from '../ai-answer-guard.js';
import { buildCardItem, changeGateFor, validateChange } from '../ai-preview.js';
import { domainSystemPrompt } from '../system-prompts/domains.js';
import {
  BILLING_PACK_OPS,
  billingCardAmount,
  billingCardWarnings,
  duplicateWindowMonths,
  expenseDuplicates,
  pullPreviewArgs,
} from './billing.js';
import { PACK_OPS, packTools } from './index.js';

/**
 * 62-29 (plan 62 §9) — the billing assistant: totals from tools only; a likely duplicate expense
 * named on its card; issuing an invoice is `money` (step-up, typed total, approval).
 */

const INVOICE = 'inv-0195f0a0-0000-7000-8000-000000000042';
const noReads = () => Promise.reject(new Error('no read expected'));

describe('billing pack (62-29)', () => {
  it('is the billing domain pack: reads, then draft, pull, issue and expense', () => {
    expect(PACK_OPS.billing).toBe(BILLING_PACK_OPS);
    const names = packTools('billing').map((tool) => tool.name);
    for (const name of [
      'client_invoices_create',
      'client_invoices_pull',
      'client_invoices_pull_preview',
      'client_invoices_send',
      'finance_expenses_create',
    ]) {
      expect(names).toContain(name);
    }
    for (const id of BILLING_PACK_OPS) {
      const op = findOpById(id)!;
      expect(allDetailsById.has(id), id).toBe(true);
      // Every change but the empty draft is money: none of them runs at once (62-11).
      if (op.risk !== 'read') {
        expect(sensitivityOf(op), id).toBe(id === 'client_invoices.create' ? 'none' : 'money');
      }
    }
    expect(domainSystemPrompt('billing')).toContain('Never state a figure no tool returned');
  });

  it('totals from tools only: a sum the model added up is withheld, a returned total is kept', () => {
    const evidence = [
      JSON.stringify({ invoices: [{ totalMinor: 120_000 }, { totalMinor: 80_000 }] }),
    ];
    const kept = guardAnswer('INV-1 is $1,200.00 and INV-2 is $800.00.', evidence);
    expect(kept.withheldFigures).toBe(0);
    const summed = guardAnswer('Together they owe $2,000.00.', evidence);
    expect(summed.withheldFigures).toBe(1);
    expect(summed.text).not.toContain('2,000');
  });

  it('issuing an invoice is money: confirm, step-up, the invoice total typed back', async () => {
    const op = findOpById('client_invoices.send')!;
    expect(op.risk).toBe('confirm');
    const gate = changeGateFor(op, { runAtOnce: true, hasUndo: false })!;
    expect(gate).toMatchObject({
      sensitivity: 'money',
      card: true,
      stepUp: true,
      typedAmount: true,
      approvalRule: true,
      cannotBeUndone: true,
    });
    const current = { number: null, subtotalMinor: 100_000, taxMinor: 14_000, totalMinor: 114_000 };
    const amount = await billingCardAmount(
      'client_invoices.send',
      { invoiceId: INVOICE, to: ['ap@cedar.example'] },
      current,
      noReads,
    );
    expect(amount).toBe(114_000);
    expect(await billingCardAmount('client_invoices.send', {}, null, noReads)).toBeNull();
  });

  it('a draft from approved hours: the pull card names the server-computed total after the pull', async () => {
    const args = {
      invoiceId: INVOICE,
      period: { from: '2026-10-01', to: '2026-10-31' },
      include: { time: 'by_task', expenses: true },
    };
    expect(validateChange('client_invoices.pull', args)).not.toBeNull();
    const asked: unknown[] = [];
    const amount = await billingCardAmount('client_invoices.pull', args, null, (opId, query) => {
      asked.push([opId, query]);
      return Promise.resolve({ invoiceId: INVOICE, totalBeforeMinor: 0, totalMinor: 452_500 });
    });
    expect(amount).toBe(452_500);
    expect(asked).toEqual([
      [
        'client_invoices.pull_preview',
        {
          invoiceId: INVOICE,
          from: '2026-10-01',
          to: '2026-10-31',
          time: 'by_task',
          expenses: 'true',
        },
      ],
    ]);
    // The preview's own schema accepts what the pull is turned into.
    expect(
      allDetailsById.get('client_invoices.pull_preview')!.input.safeParse(pullPreviewArgs(args))
        .success,
    ).toBe(true);
    // A refused preview: the amount is unknown, so the confirm refuses (fail closed).
    expect(
      await billingCardAmount('client_invoices.pull', args, null, () => Promise.resolve(null)),
    ).toBeNull();
    // An expense names its own amount.
    expect(
      await billingCardAmount('finance.expenses.create', { amountMinor: 4900 }, null, noReads),
    ).toBe(4900);
    expect(await billingCardAmount('work_items.update', {}, null, noReads)).toBeUndefined();
  });

  it('an empty draft is an everyday change: a card, no step-up, no typed amount', async () => {
    const op = findOpById('client_invoices.create')!;
    expect(sensitivityOf(op)).toBe('none');
    // No inverse (invoices are voided, never deleted), so even "run at once" shows the card.
    const gate = changeGateFor(op, { runAtOnce: true, hasUndo: false })!;
    expect(gate).toMatchObject({
      sensitivity: 'none',
      card: true,
      stepUp: false,
      typedAmount: false,
      approvalRule: false,
      cannotBeUndone: true,
    });
    expect(
      await billingCardAmount(
        'client_invoices.create',
        { clientOrganizationId: 'c' },
        null,
        noReads,
      ),
    ).toBeUndefined();
    // Pull, issue and expense keep the money gate.
    for (const id of ['client_invoices.pull', 'client_invoices.send', 'finance.expenses.create']) {
      const money = changeGateFor(findOpById(id)!, { runAtOnce: true, hasUndo: true })!;
      expect(money, id).toMatchObject({
        sensitivity: 'money',
        card: true,
        stepUp: true,
        typedAmount: true,
      });
    }
  });

  it('duplicate warned: same amount and currency within 3 days, or the same receipt', () => {
    const proposed = {
      spentOn: '2026-11-02',
      amountMinor: 4900,
      currency: 'USD',
      category: 'Software',
    };
    const listed = [
      { id: 'e1', spentOn: '2026-10-31', amountMinor: 4900, currency: 'USD', state: 'approved' },
      { id: 'e2', spentOn: '2026-11-06', amountMinor: 4900, currency: 'USD', state: 'submitted' },
      { id: 'e3', spentOn: '2026-11-02', amountMinor: 4900, currency: 'EUR', state: 'submitted' },
      { id: 'e4', spentOn: '2026-11-02', amountMinor: 4900, currency: 'USD', state: 'rejected' },
      {
        id: 'e5',
        spentOn: '2026-09-01',
        amountMinor: 1,
        currency: 'USD',
        receiptFileAssetId: 'f1',
      },
      'not an expense',
    ];
    expect(expenseDuplicates(proposed, listed)).toEqual(['e1']);
    expect(expenseDuplicates({ ...proposed, receiptFileAssetId: 'f1' }, listed)).toEqual([
      'e1',
      'e5',
    ]);
    expect(duplicateWindowMonths('2026-11-02')).toEqual(['2026-10', '2026-11']);
    expect(duplicateWindowMonths('2026-11-15')).toEqual(['2026-11']);
    expect(duplicateWindowMonths('nope')).toEqual([]);
  });

  it('duplicate warned on the card: read through the member surface for each month touched', async () => {
    const reads: unknown[] = [];
    const warnings = await billingCardWarnings(
      'finance.expenses.create',
      { spentOn: '2026-11-01', amountMinor: 4900, currency: 'USD' },
      (opId, args) => {
        reads.push([opId, args]);
        return Promise.resolve(
          args['period'] === '2026-10'
            ? {
                expenses: [{ id: 'e1', spentOn: '2026-10-30', amountMinor: 4900, currency: 'USD' }],
              }
            : null,
        );
      },
    );
    expect(reads).toEqual([
      ['finance.expenses.list', { period: '2026-10' }],
      ['finance.expenses.list', { period: '2026-11' }],
    ]);
    expect(warnings).toEqual([{ code: 'possible_duplicate', expenseIds: ['e1'] }]);
    expect(await billingCardWarnings('client_invoices.create', {}, noReads)).toEqual([]);
  });

  it('the card carries the decided amount and the duplicate warning', () => {
    const change = validateChange('finance.expenses.create', {
      spentOn: '2026-11-01',
      category: 'Software',
      amountMinor: 4900,
      currency: 'USD',
    })!;
    const gate = changeGateFor(change.op, { runAtOnce: true, hasUndo: true })!;
    const item = buildCardItem(0, change, gate, null, null, {
      amount: 4900,
      warnings: [{ code: 'possible_duplicate', expenseIds: ['e1'] }],
    });
    expect(item).toMatchObject({
      sensitivity: 'money',
      stepUp: true,
      typedAmount: true,
      amount: 4900,
      warnings: [{ code: 'possible_duplicate', expenseIds: ['e1'] }],
    });
  });
});
