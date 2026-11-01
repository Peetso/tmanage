'use client';

import type { Editor, Range } from '@tiptap/core';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';

import type { CalloutKind } from './schema-extensions';

/**
 * The state of an open suggestion popup ("/" blocks or "@" people): its items, the highlighted
 * row, where it sits and how to pick a row. `null` = closed.
 */
export interface PopupState<T> {
  readonly items: readonly T[];
  readonly active: number;
  readonly rect: DOMRect | null;
  readonly pick: (item: T) => void;
}

/**
 * A Suggestion `render()` that keeps no DOM of its own: it reports every change to `onChange`, and
 * the editor draws the list in React. Arrows move, Enter picks, Esc closes.
 */
export function popupRenderer<T>(
  onChange: (state: PopupState<T> | null) => void,
): NonNullable<SuggestionOptions<T>['render']> {
  return () => {
    let state: PopupState<T> | null = null;
    const publish = (next: PopupState<T> | null) => {
      state = next;
      onChange(next);
    };
    const from = (props: SuggestionProps<T>, active = 0): PopupState<T> => ({
      items: props.items,
      active: Math.min(active, Math.max(props.items.length - 1, 0)),
      rect: props.clientRect?.() ?? null,
      pick: (item: T) => props.command(item),
    });
    return {
      onStart: (props) => publish(from(props)),
      onUpdate: (props) => publish(from(props, 0)),
      onExit: () => publish(null),
      onKeyDown: ({ event }) => {
        if (!state) return false;
        if (event.key === 'Escape') {
          publish(null);
          return true;
        }
        const count = state.items.length;
        if (count === 0) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          publish({ ...state, active: (state.active + step + count) % count });
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = state.items[state.active];
          if (item !== undefined) state.pick(item);
          return true;
        }
        return false;
      },
    };
  };
}

/** What a "/" row needs besides the editor: the dialogs it opens. */
export interface SlashContext {
  readonly openImage: (mode: 'image' | 'file') => void;
  readonly openEmbed: () => void;
}

export interface SlashItem {
  readonly id: string;
  readonly key: string;
  readonly english: string;
  readonly glyph: string;
  /** The Markdown-ish shortcut shown on the end side ("#", "[]"), when there is one. */
  readonly hint?: string;
  readonly words: readonly string[];
  readonly run: (editor: Editor, range: Range, ctx: SlashContext) => void;
}

const callout = (kind: CalloutKind, english: string): SlashItem => ({
  id: `callout-${kind}`,
  key: `SlashMenu.callout${kind[0]?.toUpperCase()}${kind.slice(1)}`,
  english,
  glyph: '▣',
  words: ['callout', 'note', kind],
  run: (editor, range) =>
    editor.chain().focus().deleteRange(range).wrapIn('callout', { kind }).run(),
});

/** Every block the "/" menu inserts (R5-SPEC §2), in menu order (Figma 484:28763). */
export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'h1',
    key: 'SlashMenu.h1',
    english: 'Heading 1',
    glyph: 'H1',
    hint: '#',
    words: ['heading', 'title', 'h1'],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 1 }).run(),
  },
  {
    id: 'h2',
    key: 'SlashMenu.h2',
    english: 'Heading 2',
    glyph: 'H2',
    hint: '##',
    words: ['heading', 'subtitle', 'h2'],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 2 }).run(),
  },
  {
    id: 'h3',
    key: 'SlashMenu.h3',
    english: 'Heading 3',
    glyph: 'H3',
    hint: '###',
    words: ['heading', 'h3'],
    run: (e, r) => e.chain().focus().deleteRange(r).setNode('heading', { level: 3 }).run(),
  },
  {
    id: 'bullets',
    key: 'SlashMenu.bullets',
    english: 'Bulleted list',
    glyph: '•',
    hint: '-',
    words: ['list', 'bullet'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
  },
  {
    id: 'numbers',
    key: 'SlashMenu.numbers',
    english: 'Numbered list',
    glyph: '1.',
    hint: '1.',
    words: ['list', 'number', 'ordered'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run(),
  },
  {
    id: 'checklist',
    key: 'SlashMenu.checklist',
    english: 'Task list',
    glyph: '☐',
    hint: '[]',
    words: ['checklist', 'todo', 'task'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
  },
  {
    id: 'table',
    key: 'SlashMenu.table',
    english: 'Table',
    glyph: '▦',
    words: ['table', 'grid'],
    run: (e, r) =>
      e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'image',
    key: 'SlashMenu.image',
    english: 'Image',
    glyph: '▨',
    words: ['image', 'picture', 'photo'],
    run: (e, r, ctx) => {
      e.chain().focus().deleteRange(r).run();
      ctx.openImage('image');
    },
  },
  {
    id: 'file',
    key: 'SlashMenu.file',
    english: 'File',
    glyph: '⎘',
    words: ['file', 'attachment', 'upload'],
    run: (e, r, ctx) => {
      e.chain().focus().deleteRange(r).run();
      ctx.openImage('file');
    },
  },
  {
    id: 'embed',
    key: 'SlashMenu.embed',
    english: 'Embed',
    glyph: '◫',
    words: ['embed', 'figma', 'youtube', 'vimeo', 'video'],
    run: (e, r, ctx) => {
      e.chain().focus().deleteRange(r).run();
      ctx.openEmbed();
    },
  },
  callout('info', 'Info callout'),
  callout('warn', 'Warning callout'),
  callout('success', 'Success callout'),
  callout('danger', 'Danger callout'),
  {
    id: 'code',
    key: 'SlashMenu.code',
    english: 'Code block',
    glyph: '</>',
    hint: '```',
    words: ['code', 'snippet'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run(),
  },
  {
    id: 'quote',
    key: 'SlashMenu.quote',
    english: 'Quote',
    glyph: '❝',
    hint: '>',
    words: ['quote', 'blockquote'],
    run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
  },
  {
    id: 'divider',
    key: 'SlashMenu.divider',
    english: 'Divider',
    glyph: '—',
    hint: '---',
    words: ['divider', 'rule', 'line'],
    run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
  },
];

/** The rows a "/query" still matches, by label (either language) or extra word, in menu order. */
export function filterSlashItems(
  query: string,
  labelOf: (item: SlashItem) => string,
): readonly SlashItem[] {
  const q = query.trim().toLowerCase();
  if (q === '') return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) =>
      labelOf(item).toLowerCase().includes(q) ||
      item.english.toLowerCase().includes(q) ||
      item.words.some((word) => word.startsWith(q)),
  );
}

export interface SlashMenuProps {
  readonly state: PopupState<SlashItem>;
  readonly labelOf: (item: SlashItem) => string;
  readonly ariaLabel: string;
  readonly noneLabel: string;
  readonly hintLabel: string;
}

/** The "/" list (Figma 484:28763): glyph, label, shortcut hint; the active row is highlighted. */
export function SlashMenu({ state, labelOf, ariaLabel, noneLabel, hintLabel }: SlashMenuProps) {
  const rect = state.rect;
  return (
    <div
      className="tm-docpage__slash tm-doced__popup"
      style={rect ? { position: 'fixed', top: rect.bottom + 4, left: rect.left } : undefined}
      data-empty={state.items.length === 0 ? 'true' : 'false'}
    >
      {state.items.length > 0 ? (
        <ul id="tm-doc-slash" role="listbox" aria-label={ariaLabel}>
          {state.items.map((item, index) => (
            <li
              key={item.id}
              id={`tm-doc-slash-${index}`}
              role="option"
              aria-selected={index === state.active}
              className="tm-docpage__slash-item"
              onMouseDown={(event) => {
                event.preventDefault();
                state.pick(item);
              }}
            >
              <span className="tm-docpage__slash-glyph" aria-hidden="true">
                {item.glyph}
              </span>
              <span className="tm-doced__popup-label">{labelOf(item)}</span>
              {item.hint ? (
                <kbd className="tm-doced__popup-hint" dir="ltr">
                  {item.hint}
                </kbd>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="tm-docpage__slash-none">{noneLabel}</p>
      )}
      <p className="tm-docpage__slash-hint" aria-hidden="true">
        {hintLabel}
      </p>
    </div>
  );
}
