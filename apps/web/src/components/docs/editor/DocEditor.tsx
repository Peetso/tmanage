'use client';

import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ApiClient } from '../../../lib/api/client';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { markdownToHtml } from './doc-legacy-markdown';
import './doc-editor.css';
import { EditorToolbar } from './EditorToolbar';
import { InsertEmbedDialog } from './InsertEmbedDialog';
import { InsertImageDialog, type UploadedDocFile } from './InsertImageDialog';
import {
  MentionList,
  mentionSuggestion,
  workItemSuggestion,
  type MentionItem,
} from './MentionList';
import { DocCollab } from './collab-steps';
import { docExtensions } from './schema-extensions';
import { LinkForm, SelectionToolbar } from './SelectionToolbar';
import {
  filterSlashItems,
  popupRenderer,
  SlashMenu,
  type PopupState,
  type SlashContext,
  type SlashItem,
} from './SlashMenu';
import { TableControls } from './TableControls';

export interface DocEditorProps {
  /** The stored body. Read once on mount: remount (a new `key`) to load another version. */
  readonly value: string;
  /** `markdown` bodies (the textarea era) are converted to HTML once, on mount. */
  readonly format: 'markdown' | 'html';
  /** Every change, as HTML (`''` while the document is empty). */
  readonly onChange: (html: string) => void;
  readonly onUploadFile: (file: File) => Promise<UploadedDocFile>;
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly dir?: 'ltr' | 'rtl';
  readonly onComment?: (anchor: { readonly id: string; readonly quote: string }) => void;
  /** Drawn on the sheet above the body (title, Draft pill) and below it (alerts, history). */
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  /** 53-10: live co-editing from this version on (read once on mount, like `value`). */
  readonly collab?: { readonly version: number };
  /** 53-10: the Tiptap editor once created, for the co-editing sync loop. */
  readonly onEditor?: (editor: Editor | null) => void;
}

/**
 * **The document editor** (R5, Figma 483:28731): Tiptap on the one document schema — fixed
 * toolbar, floating selection toolbar, the "/" menu of every block, table controls, image/file
 * upload, embeds, callouts, code and "@" mentions. Every block gets `dir="auto"`, so an Arabic
 * paragraph lays out right-to-left beside an English one.
 */
export function DocEditor({
  value,
  format,
  onChange,
  onUploadFile,
  api,
  organizationSlug,
  dir,
  onComment,
  header,
  footer,
  collab,
  onEditor,
}: DocEditorProps) {
  const tOr = useTOr();
  const [slash, setSlash] = useState<PopupState<SlashItem> | null>(null);
  const [mention, setMention] = useState<PopupState<MentionItem> | null>(null);
  const [workItem, setWorkItem] = useState<PopupState<MentionItem> | null>(null);
  const [dialog, setDialog] = useState<'image' | 'file' | 'embed' | null>(null);
  const [linking, setLinking] = useState(false);
  const change = useRef(onChange);
  change.current = onChange;
  const label = useRef(tOr);
  label.current = tOr;
  const labelOf = (item: SlashItem) => label.current(item.key, item.english);

  const initial = useMemo(
    () => (format === 'markdown' ? markdownToHtml(value) : value),
    // The body is read once; a reload remounts the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    immediatelyRender: false,
    textDirection: 'auto',
    extensions: [
      ...docExtensions({
        placeholder: tOr(
          'DocEditor.placeholder',
          'Start writing, or type / for headings, tables, images and more.',
        ),
        mentionSuggestion: mentionSuggestion(api, organizationSlug, setMention),
        workItemSuggestion: workItemSuggestion(api, organizationSlug, setWorkItem),
        slashSuggestion: {
          items: ({ query }: { query: string }) => [
            ...filterSlashItems(query, (item) => label.current(item.key, item.english)),
          ],
          command: ({ editor: current, range, props }) => {
            const ctx: SlashContext = {
              openImage: (mode) => setDialog(mode),
              openEmbed: () => setDialog('embed'),
            };
            (props as SlashItem).run(current, range, ctx);
          },
          render: popupRenderer<SlashItem>(setSlash) as never,
        },
      }),
      ...(collab ? [DocCollab.configure({ version: collab.version })] : []),
    ],
    content: initial,
    editorProps: {
      attributes: {
        id: 'tm-doc-body',
        class: 'tm-doced__body',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': tOr('DocEditor.bodyAria', 'Document body'),
      },
    },
    onUpdate: ({ editor: current }) => change.current(current.isEmpty ? '' : current.getHTML()),
  });

  const announce = useRef(onEditor);
  announce.current = onEditor;
  useEffect(() => {
    announce.current?.(editor);
    return () => announce.current?.(null);
  }, [editor]);

  return (
    <div className="tm-doced" dir={dir}>
      <EditorToolbar
        editor={editor}
        onImage={(mode) => setDialog(mode)}
        onEmbed={() => setDialog('embed')}
        onLink={() => setLinking(true)}
      />
      {editor && linking ? (
        <div className="tm-doced__linkrow">
          <LinkForm editor={editor} onDone={() => setLinking(false)} />
        </div>
      ) : null}
      <TableControls editor={editor} />
      <div className="tm-docpage__sheet tm-doced__sheet">
        {header}
        <EditorContent editor={editor} className="tm-doced__content" />
        {footer}
      </div>
      {editor ? <SelectionToolbar editor={editor} {...(onComment ? { onComment } : {})} /> : null}
      {slash ? (
        <SlashMenu
          state={slash}
          labelOf={labelOf}
          ariaLabel={tOr('SlashMenu.aria', 'Insert a block')}
          noneLabel={tOr('SlashMenu.none', 'No matching blocks')}
          hintLabel={tOr('SlashMenu.hint', '↑ ↓ to move · Enter to insert · Esc to close')}
        />
      ) : null}
      {mention ? (
        <MentionList
          state={mention}
          ariaLabel={tOr('DocEditor.mentionAria', 'Mention someone')}
          noneLabel={tOr('DocEditor.mentionNone', 'No one by that name')}
        />
      ) : null}
      {workItem ? (
        <MentionList
          state={workItem}
          glyph={() => '#'}
          ariaLabel={tOr('DocEditor.workItemAria', 'Link a work item')}
          noneLabel={tOr('DocEditor.workItemNone', 'Type a work item title')}
        />
      ) : null}
      {editor && (dialog === 'image' || dialog === 'file') ? (
        <InsertImageDialog
          editor={editor}
          mode={dialog}
          onUploadFile={onUploadFile}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {editor && dialog === 'embed' ? (
        <InsertEmbedDialog editor={editor} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}
