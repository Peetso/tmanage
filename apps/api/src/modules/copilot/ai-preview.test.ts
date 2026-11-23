import { describe, expect, it } from 'vitest';
import { OPS, OP_SENSITIVITY, findOpById, sensitivityOf } from '../ai-actions/registry/index.js';
import { changeGateFor } from './ai-preview.js';

/**
 * 62-11 part 1 (plan 62 §4.3, §7 "every class stops at its gate") — the gate of each sensitivity
 * class, checked on real registry ops, and the fail-closed default.
 */

const op = (id: string) => {
  const found = findOpById(id);
  if (found === undefined) throw new Error(`no op ${id}`);
  return found;
};
const AT_ONCE = { runAtOnce: true, hasUndo: true };
const DEFAULT = { runAtOnce: false, hasUndo: true };

describe('every class stops at its gate', () => {
  it('reads need no gate', () => {
    expect(changeGateFor(op('work_items.list'), AT_ONCE)).toBeNull();
    expect(sensitivityOf(op('work_items.list'))).toBe('none');
  });

  it('money: card, step-up, typed amount, approval rule — even with run at once', () => {
    expect(changeGateFor(op('client_invoices.send'), AT_ONCE)).toMatchObject({
      sensitivity: 'money',
      card: true,
      stepUp: true,
      typedAmount: true,
      approvalRule: true,
    });
    expect(changeGateFor(op('finance.expenses.create'), AT_ONCE)?.card).toBe(true);
  });

  it('hr: card, step-up and approval rule, no amount', () => {
    expect(changeGateFor(op('members.role.update'), AT_ONCE)).toMatchObject({
      sensitivity: 'hr',
      card: true,
      stepUp: true,
      typedAmount: false,
      approvalRule: true,
    });
  });

  it('external and destructive: always a card, no step-up', () => {
    for (const id of ['invitations.create', 'portal.messages.create', 'work_items.delete']) {
      expect(changeGateFor(op(id), AT_ONCE)).toMatchObject({ card: true, stepUp: false });
    }
    expect(sensitivityOf(op('work_items.delete'))).toBe('destructive');
    expect(sensitivityOf(op('portal.messages.create'))).toBe('external');
  });

  it('none: a card by default; run at once only for a write op with an undo', () => {
    expect(changeGateFor(op('work_items.create'), DEFAULT)?.card).toBe(true);
    expect(changeGateFor(op('work_items.create'), AT_ONCE)?.card).toBe(false);
    expect(
      changeGateFor(op('work_items.create'), { runAtOnce: true, hasUndo: false }),
    ).toMatchObject({ card: true, cannotBeUndone: true });
  });

  it('a confirm-class everyday op still asks with run at once', () => {
    const confirmNone = OPS.find((o) => o.risk === 'confirm' && OP_SENSITIVITY[o.id] === 'none');
    expect(confirmNone).toBeDefined();
    expect(changeGateFor(confirmNone!, AT_ONCE)?.card).toBe(true);
  });

  it('full rights (owner 2026-11-23): every manage, billing or DELETE change asks, even with run at once', () => {
    const always = OPS.filter(
      (o) =>
        o.risk !== 'read' &&
        (o.scope === 'manage' || o.scope === 'billing' || o.method === 'DELETE'),
    );
    expect(always.length).toBeGreaterThan(0);
    for (const o of always) expect(changeGateFor(o, AT_ONCE)?.card, o.id).toBe(true);
    // The scope rule holds on its own: a manage write with no other sensitivity still asks.
    const everydayManage = OPS.find(
      (o) => o.scope === 'manage' && o.risk === 'write' && sensitivityOf(o) === 'none',
    );
    expect(everydayManage).toBeDefined();
    expect(changeGateFor(everydayManage!, AT_ONCE)?.card).toBe(true);
    // An everyday write-scope change keeps the owner's run at once.
    expect(changeGateFor(op('work_items.create'), AT_ONCE)?.card).toBe(false);
  });

  it('an unclassified change fails closed as destructive', () => {
    expect(sensitivityOf({ id: 'future.op', risk: 'write' })).toBe('destructive');
  });
});
