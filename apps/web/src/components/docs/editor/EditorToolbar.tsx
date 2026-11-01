'use client';

import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { Fragment, useState } from 'react';

import { useTOr } from '../../../lib/i18n/use-t-or';

type ToolId =
  | 'undo'
  | 'redo'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'bullets'
  | 'numbers'
  | 'checklist'
  | 'table'
  | 'image'
  | 'link'
  | 'callout'
  | 'code'
  | 'embed';

interface Tool {
  readonly id: ToolId;
  readonly english: string;
  /** Spoken name when the face is a letter ("B" → "Bold"). */
  readonly name?: string;
}

/** The fixed toolbar of Figma 483:28731, in its groups and order; `[dir=rtl]` mirrors the row. */
const GROUPS: readonly (readonly Tool[])[] = [
  [
    { id: 'undo', english: 'Undo', name: 'Undo edit' },
    { id: 'redo', english: 'Redo', name: 'Redo edit' },
  ],
  [
    { id: 'h1', english: 'H1', name: 'Heading 1' },
    { id: 'h2', english: 'H2', name: 'Heading 2' },
    { id: 'h3', english: 'H3', name: 'Heading 3' },
  ],
  [
    { id: 'bold', english: 'B', name: 'Bold' },
    { id: 'italic', english: 'I', name: 'Italic' },
    { id: 'underline', english: 'U', name: 'Underline' },
    { id: 'strike', english: 'S', name: 'Strikethrough' },
  ],
  [
    { id: 'bullets', english: 'Bullets' },
    { id: 'numbers', english: 'Numbers' },
    { id: 'checklist', english: 'Checklist' },
  ],
  [
    { id: 'table', english: 'Table' },
    { id: 'image', english: 'Image' },
    { id: 'link', english: 'Link' },
    { id: 'callout', english: 'Callout' },
    { id: 'code', english: 'Code' },
    { id: 'embed', english: 'Embed' },
  ],
];

export interface EditorToolbarProps {
  readonly editor: Editor | null;
  readonly onImage: (mode: 'image' | 'file') => void;
  readonly onEmbed: () => void;
  readonly onLink: () => void;
}

function run(editor: Editor, id: ToolId) {
  const chain = editor.chain().focus();
  switch (id) {
    case 'undo':
      return chain.undo().run();
    case 'redo':
      return chain.redo().run();
    case 'h1':
    case 'h2':
    case 'h3':
      return chain.toggleHeading({ level: Number(id[1]) as 1 | 2 | 3 }).run();
    case 'bold':
      return chain.toggleBold().run();
    case 'italic':
      return chain.toggleItalic().run();
    case 'underline':
      return chain.toggleUnderline().run();
    case 'strike':
      return chain.toggleStrike().run();
    case 'bullets':
      return chain.toggleBulletList().run();
    case 'numbers':
      return chain.toggleOrderedList().run();
    case 'checklist':
      return chain.toggleTaskList().run();
    case 'table':
      return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case 'callout':
      return editor.isActive('callout')
        ? chain.lift('callout').run()
        : chain.wrapIn('callout', { kind: 'info' }).run();
    case 'code':
      return chain.toggleCodeBlock().run();
    default:
      return false;
  }
}

function isOn(editor: Editor, id: ToolId): boolean {
  switch (id) {
    case 'h1':
    case 'h2':
    case 'h3':
      return editor.isActive('heading', { level: Number(id[1]) });
    case 'bullets':
      return editor.isActive('bulletList');
    case 'numbers':
      return editor.isActive('orderedList');
    case 'checklist':
      return editor.isActive('taskList');
    case 'code':
      return editor.isActive('codeBlock');
    case 'bold':
    case 'italic':
    case 'underline':
    case 'strike':
    case 'link':
    case 'callout':
      return editor.isActive(id);
    default:
      return false;
  }
}

const TOGGLES: readonly ToolId[] = [
  'h1',
  'h2',
  'h3',
  'bold',
  'italic',
  'underline',
  'strike',
  'bullets',
  'numbers',
  'checklist',
  'link',
  'callout',
  'code',
];

/** The fixed formatting row. Buttons never take focus, so the selection stays in the body. */
export function EditorToolbar({ editor, onImage, onEmbed, onLink }: EditorToolbarProps) {
  const tOr = useTOr();
  const [moreOpen, setMoreOpen] = useState(false);
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current
        ? {
            on: TOGGLES.filter((id) => isOn(current, id)),
            canUndo: current.can().undo(),
            canRedo: current.can().redo(),
          }
        : null,
  });

  function press(id: ToolId) {
    if (!editor) return;
    if (id === 'image') onImage('image');
    else if (id === 'embed') onEmbed();
    else if (id === 'link') onLink();
    else run(editor, id);
  }

  const more: readonly { id: string; english: string; act: () => void }[] = [
    {
      id: 'quote',
      english: 'Quote',
      act: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    {
      id: 'divider',
      english: 'Divider',
      act: () => editor?.chain().focus().setHorizontalRule().run(),
    },
    {
      id: 'inlineCode',
      english: 'Inline code',
      act: () => editor?.chain().focus().toggleCode().run(),
    },
    { id: 'file', english: 'File', act: () => onImage('file') },
  ];

  return (
    <div
      className="tm-docpage__tools tm-doced__tools"
      role="toolbar"
      aria-label={tOr('DocEditor.toolbarAria', 'Formatting')}
    >
      {GROUPS.map((group, index) => (
        <Fragment key={index}>
          {index > 0 ? <span className="tm-doced__sep" aria-hidden="true" /> : null}
          {group.map((tool) => {
            const label = tOr(`DocEditor.tool.${tool.id}`, tool.english);
            const pressed = TOGGLES.includes(tool.id)
              ? (active?.on.includes(tool.id) ?? false)
              : undefined;
            const disabled =
              !editor ||
              (tool.id === 'undo' && active?.canUndo === false) ||
              (tool.id === 'redo' && active?.canRedo === false);
            return (
              <button
                key={tool.id}
                type="button"
                className="tm-docpage__tool"
                data-tool={tool.id}
                aria-label={tool.name ? tOr(`DocEditor.toolName.${tool.id}`, tool.name) : undefined}
                aria-pressed={pressed}
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => press(tool.id)}
              >
                {label}
              </button>
            );
          })}
        </Fragment>
      ))}
      <span className="tm-doced__sep" aria-hidden="true" />
      <div className="tm-doced__more">
        <button
          type="button"
          className="tm-docpage__tool"
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          disabled={!editor}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setMoreOpen((open) => !open)}
        >
          {tOr('DocEditor.tool.more', 'More')}
        </button>
        {moreOpen ? (
          <ul className="tm-doced__menu" role="menu">
            {more.map((item) => (
              <li key={item.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className="tm-doced__menu-item"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setMoreOpen(false);
                    item.act();
                  }}
                >
                  {tOr(`DocEditor.tool.${item.id}`, item.english)}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
