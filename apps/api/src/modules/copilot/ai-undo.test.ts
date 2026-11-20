import { describe, expect, it } from 'vitest';
import { OPS, findOpById, sensitivityOf } from '../ai-actions/registry/index.js';
import {
  AI_UNDO_WINDOW_MS,
  captureUndo,
  changedSince,
  inverseOf,
  withinUndoWindow,
} from './ai-undo.js';

/**
 * 62-11 part 2 (plan 62 §4.3) — the inverse of a change, derived from the registry: update →
 * restore the captured values, create → delete or archive; nothing else can be undone; a record
 * changed since refuses the undo.
 */

const op = (id: string) => {
  const found = findOpById(id);
  if (found === undefined) throw new Error(`no op ${id}`);
  return found;
};

describe('inverses come from the registry', () => {
  it('update restores through the same op; create is removed through the delete', () => {
    expect(inverseOf(op('work_items.update'))).toEqual({
      kind: 'restore',
      readOpId: 'work_items.get',
      inverseOpId: 'work_items.update',
    });
    expect(inverseOf(op('work_items.create'))).toEqual({
      kind: 'remove',
      readOpId: 'work_items.get',
      inverseOpId: 'work_items.delete',
      idParam: 'workItemId',
    });
  });

  it('reads, and money / HR / external / destructive changes, have no inverse', () => {
    expect(inverseOf(op('work_items.get'))).toBeNull();
    for (const changing of OPS.filter((o) => o.risk !== 'read' && sensitivityOf(o) !== 'none')) {
      expect(inverseOf(changing)).toBeNull();
    }
  });

  it('every inverse names ops that exist, and its read is a read', () => {
    const specs = OPS.map((o) => inverseOf(o)).filter((s) => s !== null);
    // Today: work items, documents, decisions, conversations and custom reports. An update whose
    // record has no read on its own path cannot capture its "before" and says "cannot be undone".
    expect(specs.length).toBeGreaterThanOrEqual(7);
    for (const spec of specs) {
      expect(findOpById(spec.inverseOpId)).toBeDefined();
      expect(findOpById(spec.readOpId)?.risk).toBe('read');
    }
  });
});

describe('capture and the changed-since rule', () => {
  const update = op('work_items.update');
  const args = { workItemId: 'wi_1', dueAt: '2026-11-23T09:00:00Z', version: 3 };
  const before = { id: 'wi_1', dueAt: '2026-11-20T09:00:00Z', version: 3, updatedAt: 't1' };
  const after = { id: 'wi_1', dueAt: '2026-11-23T09:00:00Z', version: 4, updatedAt: 't2' };

  it('an update keeps the old values, the new version and the marker; never other fields', () => {
    const entry = captureUndo(update, inverseOf(update), args, { before, answer: after, after })!;
    expect(entry.inverseArgs).toEqual({
      workItemId: 'wi_1',
      dueAt: '2026-11-20T09:00:00Z',
      version: 4,
    });
    expect(entry.marker).toEqual({ updatedAt: 't2' });
    expect(changedSince(entry, after)).toBe(false);
    expect(changedSince(entry, { ...after, updatedAt: 't3' })).toBe(true);
    expect(changedSince(entry, null)).toBe(true);
  });

  it('a field the read does not show, or no marker after, means no undo', () => {
    expect(
      captureUndo(
        update,
        inverseOf(update),
        { workItemId: 'wi_1', title: 'x' },
        {
          before,
          answer: after,
          after,
        },
      ),
    ).toBeNull();
    expect(
      captureUndo(update, inverseOf(update), args, { before, answer: after, after: null }),
    ).toBeNull();
  });

  it('a create keeps the new id for the delete', () => {
    const create = op('work_items.create');
    const created = { id: 'wi_9', title: 'Brief', updatedAt: 't1' };
    const entry = captureUndo(
      create,
      inverseOf(create),
      { title: 'Brief' },
      {
        before: null,
        answer: created,
        after: created,
      },
    )!;
    expect(entry).toMatchObject({
      inverseOpId: 'work_items.delete',
      inverseArgs: { workItemId: 'wi_9' },
      readArgs: { workItemId: 'wi_9' },
    });
  });

  it('the window is 15 minutes', () => {
    const at = new Date('2026-11-21T10:00:00Z');
    expect(withinUndoWindow(at, new Date(at.getTime() + AI_UNDO_WINDOW_MS))).toBe(true);
    expect(withinUndoWindow(at, new Date(at.getTime() + AI_UNDO_WINDOW_MS + 1))).toBe(false);
  });
});
