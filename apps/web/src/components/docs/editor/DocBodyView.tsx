'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PmNode } from '@tiptap/pm/model';
import { EditorContent, useEditor } from '@tiptap/react';

import { docExtensions } from './schema-extensions';
import '../doc-history-panel.css';

export interface DocBodyViewProps {
  html: string;
  /** R5: a click on a `mark[data-comment]` anchor raises its id (the comments rail opens the thread). */
  onCommentClick?: (anchorId: string) => void;
  /** R5: the anchor whose mark is highlighted (`.is-active`) and scrolled into view. */
  activeAnchorId?: string | null;
}

const activeKey = new PluginKey<string | null>('tm-active-comment');

/**
 * `.is-active` on every range of the active comment mark, as a ProseMirror decoration — the DOM
 * ProseMirror owns is never edited by hand, so a re-render cannot drop or fight the class.
 */
function activeCommentDecorations(read: () => string | null) {
  return Extension.create({
    name: 'tmActiveComment',
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: activeKey,
          props: {
            decorations(state) {
              const active = read();
              if (!active) return null;
              const found: Decoration[] = [];
              state.doc.descendants((node: PmNode, pos: number) => {
                if (!node.isText) return;
                const hit = node.marks.some(
                  (mark) => mark.type.name === 'comment' && mark.attrs['commentId'] === active,
                );
                if (hit)
                  found.push(Decoration.inline(pos, pos + node.nodeSize, { class: 'is-active' }));
              });
              return DecorationSet.create(state.doc, found);
            },
          },
        }),
      ];
    },
  });
}

/**
 * Read-only view of an `html` document body. The HTML goes through the ProseMirror schema
 * (unknown nodes drop) — never `dangerouslySetInnerHTML`. Every block reads its own direction
 * (`unicode-bidi: plaintext` in doc-history-panel.css — the CSS form of `dir="auto"` per block),
 * so an Arabic paragraph in an English document aligns to its own start.
 */
export function DocBodyView({ html, onCommentClick, activeAnchorId = null }: DocBodyViewProps) {
  const activeRef = useRef<string | null>(activeAnchorId);
  activeRef.current = activeAnchorId;
  const extensions = useMemo(
    () => [...docExtensions(), activeCommentDecorations(() => activeRef.current)],
    [],
  );
  const editor = useEditor(
    {
      editable: false,
      immediatelyRender: false,
      extensions,
      content: html,
      editorProps: { attributes: { dir: 'auto' } },
    },
    [html],
  );
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Redraw the decoration and bring the active anchor into view when the rail picks a thread.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(activeKey, activeAnchorId));
    if (!activeAnchorId) return;
    const mark = Array.from(
      hostRef.current?.querySelectorAll<HTMLElement>('mark[data-comment]') ?? [],
    ).find((element) => element.getAttribute('data-comment') === activeAnchorId);
    mark?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }, [editor, activeAnchorId]);

  // Mark → rail: a pointer click on an anchor raises its id. Keyboard users reach the same thread
  // from the rail's quote button, which is a real button; the marks themselves stay plain text.
  const clickRef = useRef(onCommentClick);
  clickRef.current = onCommentClick;
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const onClick = (event: MouseEvent) => {
      const mark = (event.target as HTMLElement | null)?.closest?.('mark[data-comment]');
      const id = mark?.getAttribute('data-comment');
      if (id) clickRef.current?.(id);
    };
    host.addEventListener('click', onClick);
    return () => host.removeEventListener('click', onClick);
  }, []);

  return (
    <div ref={hostRef} className="tm-doc-view">
      <EditorContent editor={editor} dir="auto" className="tm-doc-body" />
    </div>
  );
}
