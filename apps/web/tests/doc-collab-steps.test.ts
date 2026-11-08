import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import {
  collabPlugin,
  collabVersion,
  receiveSteps,
  sendableSteps,
  stepsFromJson,
} from '../src/components/docs/editor/collab-steps';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
});

function client(text: string): EditorState {
  return EditorState.create({
    doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])]),
    plugins: [collabPlugin(0)],
  });
}

const typeAt = (state: EditorState, pos: number, text: string) =>
  state.apply(state.tr.insertText(text, pos));

describe('collab steps (53-10)', () => {
  it('rebases local unconfirmed steps over remote ones so both editors converge', () => {
    let a = typeAt(client('hello'), 1, 'A');
    let b = typeAt(client('hello'), 6, 'B');
    // The authority takes A first; B's push is refused and B receives A's steps.
    const fromA = sendableSteps(a);
    const wire = stepsFromJson(
      schema,
      (fromA?.steps ?? []).map((s) => s.toJSON() as unknown),
    );
    a = a.apply(receiveSteps(a, fromA?.steps ?? [], ['a'], 'a'));
    b = b.apply(receiveSteps(b, wire, ['a'], 'b'));
    expect(collabVersion(b)).toBe(1);
    // B's rebased step goes out on version 1 and A receives it.
    const fromB = sendableSteps(b);
    expect(fromB?.version).toBe(1);
    b = b.apply(receiveSteps(b, fromB?.steps ?? [], ['b'], 'b'));
    a = a.apply(receiveSteps(a, fromB?.steps ?? [], ['b'], 'a'));
    expect(a.doc.textContent).toBe('AhelloB');
    expect(b.doc.eq(a.doc)).toBe(true);
    expect(sendableSteps(a)).toBeNull();
    expect(sendableSteps(b)).toBeNull();
    expect(collabVersion(a)).toBe(2);
  });

  it('confirming its own steps only advances the version', () => {
    let a = typeAt(client('x'), 1, 'y');
    const own = sendableSteps(a);
    a = a.apply(receiveSteps(a, own?.steps ?? [], ['a'], 'a'));
    expect(a.doc.textContent).toBe('yx');
    expect(collabVersion(a)).toBe(1);
  });
});
