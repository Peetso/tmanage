'use client';

import type { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { safeHref } from '../DocMarkdown';
import { useTOr } from '../../../lib/i18n/use-t-or';

/** An address a link may carry: http(s), mailto or a same-site path; a bare host gets https. */
export function normaliseHref(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:|^\//iu.test(text) ? text : `https://${text}`;
  return safeHref(withScheme);
}

export interface LinkFormProps {
  readonly editor: Editor;
  readonly onDone: () => void;
}

/** Set, change or remove the link on the selection. Enter applies, Esc cancels. */
export function LinkForm({ editor, onDone }: LinkFormProps) {
  const tOr = useTOr();
  const input = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(
    () => (editor.getAttributes('link')['href'] as string | undefined) ?? '',
  );
  const [invalid, setInvalid] = useState(false);
  useEffect(() => input.current?.focus(), []);

  function apply(event: FormEvent) {
    event.preventDefault();
    if (value.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      onDone();
      return;
    }
    const href = normaliseHref(value);
    if (!href) {
      setInvalid(true);
      return;
    }
    const chain = editor.chain().focus().extendMarkRange('link');
    if (editor.state.selection.empty && !editor.isActive('link')) {
      chain.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] });
    } else {
      chain.setLink({ href });
    }
    chain.run();
    onDone();
  }

  return (
    <form noValidate className="tm-doced__linkform" onSubmit={apply}>
      <input
        ref={input}
        type="text"
        inputMode="url"
        dir="ltr"
        className="tm-doced__input"
        aria-label={tOr('DocEditor.linkAddress', 'Link address')}
        aria-invalid={invalid || undefined}
        placeholder="https://"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            editor.commands.focus();
            onDone();
          }
        }}
      />
      <button type="submit" className="tm-docpage__tool">
        {tOr('DocEditor.linkApply', 'Apply')}
      </button>
    </form>
  );
}

export interface SelectionToolbarProps {
  readonly editor: Editor;
  /** Anchors a comment thread on the selection; the button shows only when it is given. */
  readonly onComment?: (anchor: { readonly id: string; readonly quote: string }) => void;
}

const MARKS = [
  { id: 'bold', face: 'B', english: 'Bold' },
  { id: 'italic', face: 'I', english: 'Italic' },
  { id: 'underline', face: 'U', english: 'Underline' },
  { id: 'strike', face: 'S', english: 'Strikethrough' },
] as const;

/** The floating toolbar on a text selection (Figma 484:28943): B I U S · Link · Comment. */
export function SelectionToolbar({ editor, onComment }: SelectionToolbarProps) {
  const tOr = useTOr();
  const [linking, setLinking] = useState(false);

  function comment() {
    if (!onComment) return;
    const { from, to } = editor.state.selection;
    const quote = editor.state.doc.textBetween(from, to, ' ').slice(0, 500);
    const id = crypto.randomUUID();
    editor.chain().focus().setMark('comment', { commentId: id }).run();
    onComment({ id, quote });
  }

  return (
    <BubbleMenu
      editor={editor}
      className="tm-doced__bubble"
      shouldShow={({ editor: current, from, to }) =>
        current.isEditable && from !== to && !current.isActive('codeBlock')
      }
    >
      {linking ? (
        <LinkForm editor={editor} onDone={() => setLinking(false)} />
      ) : (
        <div role="toolbar" aria-label={tOr('DocEditor.selectionAria', 'Selected text')}>
          {MARKS.map((mark) => (
            <button
              key={mark.id}
              type="button"
              className="tm-docpage__tool"
              aria-label={tOr(`DocEditor.toolName.${mark.id}`, mark.english)}
              aria-pressed={editor.isActive(mark.id)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => editor.chain().focus().toggleMark(mark.id).run()}
            >
              {mark.face}
            </button>
          ))}
          <span className="tm-doced__sep" aria-hidden="true" />
          <button
            type="button"
            className="tm-docpage__tool"
            aria-pressed={editor.isActive('link')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setLinking(true)}
          >
            {tOr('DocEditor.tool.link', 'Link')}
          </button>
          {onComment ? (
            <button
              type="button"
              className="tm-docpage__tool"
              onMouseDown={(event) => event.preventDefault()}
              onClick={comment}
            >
              {tOr('DocEditor.comment', 'Comment')}
            </button>
          ) : null}
        </div>
      )}
    </BubbleMenu>
  );
}
