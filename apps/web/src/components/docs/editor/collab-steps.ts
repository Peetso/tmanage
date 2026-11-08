import { Extension } from '@tiptap/core';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { Step, type Transform } from '@tiptap/pm/transform';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * Slice 53-10 — step-based co-editing on the document editor (Figma 586:33239).
 *
 * The prosemirror-collab model, written here on `@tiptap/pm` (the workspace has no collab
 * package): the editor keeps the version it last heard from the authority and the local steps the
 * authority has not confirmed yet. Remote steps arrive in order; local unconfirmed steps are
 * undone, the remote ones applied, and the local ones mapped over them and re-applied (a rebase),
 * so every editor ends on the same document. A second plugin draws the other editors' cursors in
 * their member colour.
 */

export interface RemoteCursor {
  readonly clientId: string;
  readonly name: string;
  readonly colour: number;
  readonly anchor: number;
  readonly head: number;
}

class Rebaseable {
  constructor(
    readonly step: Step,
    readonly inverted: Step,
  ) {}
}

interface CollabState {
  readonly version: number;
  readonly unconfirmed: readonly Rebaseable[];
}

interface MirrorMapping {
  setMirror(from: number, to: number): void;
}

const collabKey = new PluginKey<CollabState>('tmDocCollab');
const cursorKey = new PluginKey<DecorationSet>('tmDocCollabCursors');
const REBASE = 'tmDocCollabRebase';

function unconfirmedFrom(tr: Transaction | Transform): Rebaseable[] {
  return tr.steps.map((step, i) => {
    const doc = tr.docs[i] as PMNode;
    return new Rebaseable(step, step.invert(doc));
  });
}

/** Undo `over`, apply `remote`, then map and re-apply `over`; returns what survived. */
export function rebaseSteps(
  over: readonly Rebaseable[],
  remote: readonly Step[],
  tr: Transform,
): Rebaseable[] {
  for (let i = over.length - 1; i >= 0; i--) tr.step((over[i] as Rebaseable).inverted);
  for (const step of remote) tr.step(step);
  const result: Rebaseable[] = [];
  let mapFrom = over.length;
  for (const item of over) {
    const mapped = item.step.map(tr.mapping.slice(mapFrom));
    mapFrom--;
    if (mapped && !tr.maybeStep(mapped).failed) {
      // `setMirror` is public at runtime but marked internal in the typings; prosemirror-collab
      // relies on it the same way, so undo maps a rebased step back over its inverse.
      (tr.mapping as unknown as MirrorMapping).setMirror(mapFrom, tr.steps.length - 1);
      result.push(new Rebaseable(mapped, mapped.invert(tr.docs[tr.docs.length - 1] as PMNode)));
    }
  }
  return result;
}

export function collabPlugin(version: number): Plugin<CollabState> {
  return new Plugin<CollabState>({
    key: collabKey,
    state: {
      init: () => ({ version, unconfirmed: [] }),
      apply(tr, state) {
        const meta = tr.getMeta(collabKey) as CollabState | undefined;
        if (meta) return meta;
        if (tr.docChanged) {
          return {
            version: state.version,
            unconfirmed: [...state.unconfirmed, ...unconfirmedFrom(tr)],
          };
        }
        return state;
      },
    },
  });
}

export function collabVersion(state: EditorState): number {
  return (collabKey.getState(state) as CollabState).version;
}

export function sendableSteps(
  state: EditorState,
): { readonly version: number; readonly steps: readonly Step[] } | null {
  const collab = collabKey.getState(state);
  if (!collab || collab.unconfirmed.length === 0) return null;
  return { version: collab.version, steps: collab.unconfirmed.map((u) => u.step) };
}

/**
 * The transaction that takes `steps` (in authority order, each with the client that sent it) into
 * `state`: our own confirmed steps are dropped from the unconfirmed list, the others are applied
 * under a rebase of what is still unconfirmed.
 */
export function receiveSteps(
  state: EditorState,
  steps: readonly Step[],
  clientIds: readonly string[],
  ownClientId: string,
): Transaction {
  const collab = collabKey.getState(state) as CollabState;
  const version = collab.version + steps.length;
  let ours = 0;
  while (ours < clientIds.length && clientIds[ours] === ownClientId) ours++;
  let unconfirmed = collab.unconfirmed.slice(ours);
  const remote = steps.slice(ours);
  const tr = state.tr;
  if (remote.length === 0) {
    return tr.setMeta(collabKey, { version, unconfirmed }).setMeta('addToHistory', false);
  }
  const selection = state.selection;
  unconfirmed = rebaseSteps(unconfirmed, remote, tr);
  tr.setSelection(
    TextSelection.between(
      tr.doc.resolve(clamp(tr.mapping.map(selection.anchor), tr.doc)),
      tr.doc.resolve(clamp(tr.mapping.map(selection.head), tr.doc)),
    ),
  );
  return tr
    .setMeta(collabKey, { version, unconfirmed })
    .setMeta('addToHistory', false)
    .setMeta(REBASE, true);
}

export function stepsFromJson(schema: Schema, json: readonly unknown[]): Step[] {
  return json.map((item) => Step.fromJSON(schema, item));
}

function clamp(pos: number, doc: PMNode): number {
  return Math.max(0, Math.min(pos, doc.content.size));
}

function cursorDecorations(doc: PMNode, cursors: readonly RemoteCursor[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const cursor of cursors) {
    const colour = `tm-collab--c${cursor.colour % 6}`;
    const head = clamp(cursor.head, doc);
    const anchor = clamp(cursor.anchor, doc);
    if (anchor !== head) {
      decorations.push(
        Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), {
          class: `tm-collab__selection ${colour}`,
        }),
      );
    }
    decorations.push(
      Decoration.widget(
        head,
        () => {
          const caret = document.createElement('span');
          caret.className = `tm-collab__caret ${colour}`;
          caret.setAttribute('aria-hidden', 'true');
          const tag = document.createElement('span');
          tag.className = 'tm-collab__tag';
          tag.textContent = cursor.name.split(' ')[0] ?? cursor.name;
          caret.appendChild(tag);
          return caret;
        },
        { key: `${cursor.clientId}:${head}:${cursor.colour}:${cursor.name}`, side: 1 },
      ),
    );
  }
  return DecorationSet.create(doc, decorations);
}

export function cursorsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: cursorKey,
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, []),
      apply(tr, set) {
        const cursors = tr.getMeta(cursorKey) as readonly RemoteCursor[] | undefined;
        if (cursors) return cursorDecorations(tr.doc, cursors);
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations: (state) => cursorKey.getState(state),
    },
  });
}

export function setRemoteCursors(
  state: EditorState,
  cursors: readonly RemoteCursor[],
): Transaction {
  return state.tr.setMeta(cursorKey, cursors).setMeta('addToHistory', false);
}

/** The Tiptap extension: both plugins, starting at the joined version. */
export const DocCollab = Extension.create<{ version: number }>({
  name: 'tmDocCollab',
  addOptions: () => ({ version: 0 }),
  addProseMirrorPlugins() {
    return [collabPlugin(this.options.version), cursorsPlugin()];
  },
});
