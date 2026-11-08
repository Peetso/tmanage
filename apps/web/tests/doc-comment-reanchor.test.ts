import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { findNearestQuote, planReanchor } from '../src/components/docs/editor/comment-reanchor';

/**
 * 53-11 — doc comments survive edits. The quote search (exact, then case/spacing-insensitive, then
 * most of the words) and the per-thread state (`exact` / `moved` / `lost`) over a small ProseMirror
 * schema with the same `comment` mark the editor uses.
 */

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: {},
  },
  marks: { comment: { attrs: { commentId: { default: null } } } },
});

function doc(...paragraphs: (string | [string, string])[]) {
  return schema.node(
    'doc',
    null,
    paragraphs.map((part) =>
      typeof part === 'string'
        ? schema.node('paragraph', null, part ? [schema.text(part)] : [])
        : schema.node('paragraph', null, [
            schema.text(part[0], [schema.marks.comment!.create({ commentId: part[1] })]),
          ]),
    ),
  );
}

describe('findNearestQuote', () => {
  it('finds the exact quote nearest the hint', () => {
    const text = 'launch soon. Later we launch soon again.';
    expect(findNearestQuote(text, 'launch soon', 30)).toEqual({ from: 22, to: 33 });
    expect(findNearestQuote(text, 'launch soon')).toEqual({ from: 0, to: 11 });
  });

  it('ignores case and spacing, then falls back to most of the words', () => {
    expect(findNearestQuote('We LAUNCH   in March.', 'launch in march')).toEqual({
      from: 3,
      to: 20,
    });
    // "first" was retyped as "1st": three of four words still match in a row.
    expect(findNearestQuote('Launch in the 1st week of March', 'the first week of March')).toEqual({
      from: 18,
      to: 31,
    });
  });

  it('returns null when nothing close is left', () => {
    expect(findNearestQuote('Totally different words', 'budget approved by finance')).toBeNull();
  });
});

describe('planReanchor', () => {
  it('keeps a marked thread exact, moves an edited one and reports a removed one lost', () => {
    const body = doc(['Kick-off on Monday', 'a1'], 'We launch in the first week of March.');
    const plan = planReanchor(body, [
      { anchorId: 'a1', quote: 'Kick-off on Monday' },
      { anchorId: 'a2', quote: 'launch in the first week of March' },
      { anchorId: 'a3', quote: 'budget approved by finance' },
    ]);
    expect(plan.states).toEqual({ a1: 'exact', a2: 'moved', a3: 'lost' });
    expect(plan.ranges).toHaveLength(1);
    const range = plan.ranges[0]!;
    expect(range.anchorId).toBe('a2');
    expect(body.textBetween(range.from, range.to)).toBe('launch in the first week of March');
  });
});
