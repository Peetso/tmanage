'use client';

import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';

import { useTOr } from '../../../lib/i18n/use-t-or';

const ACTIONS = [
  {
    id: 'headerRow',
    english: 'Header row',
    act: (e: Editor) => e.chain().focus().toggleHeaderRow().run(),
  },
  { id: 'rowAfter', english: '+ Row', act: (e: Editor) => e.chain().focus().addRowAfter().run() },
  {
    id: 'colAfter',
    english: '+ Column',
    act: (e: Editor) => e.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'deleteRow',
    english: 'Delete row',
    act: (e: Editor) => e.chain().focus().deleteRow().run(),
  },
  {
    id: 'deleteCol',
    english: 'Delete column',
    act: (e: Editor) => e.chain().focus().deleteColumn().run(),
  },
  {
    id: 'deleteTable',
    english: 'Delete table',
    act: (e: Editor) => e.chain().focus().deleteTable().run(),
  },
] as const;

/**
 * The table controls of Figma 484:29129 — header-row switch, add and delete row/column, delete
 * table — shown while the caret is inside a table. Column widths drag on the cell border
 * (`resizable` in the schema).
 */
export function TableControls({ editor }: { readonly editor: Editor | null }) {
  const tOr = useTOr();
  const inTable = useEditorState({
    editor,
    selector: ({ editor: current }) => current?.isActive('table') ?? false,
  });
  if (!editor || !inTable) return null;
  return (
    <div
      className="tm-doced__tablebar"
      role="toolbar"
      aria-label={tOr('DocEditor.tableAria', 'Table')}
    >
      {ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          className="tm-docpage__tool"
          data-danger={action.id.startsWith('delete') ? 'true' : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => action.act(editor)}
        >
          {tOr(`DocEditor.table.${action.id}`, action.english)}
        </button>
      ))}
    </div>
  );
}
