import { mergeAttributes, Mark, Node, type Extensions } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Mention from '@tiptap/extension-mention';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import type { SuggestionOptions } from '@tiptap/suggestion';

/**
 * The one document schema (R5-SPEC §3). The editor, the read view and every later slice build
 * from `docExtensions()`, and the server allowlist in the API mirrors exactly this set: anything
 * the schema does not know (a `<script>`, a `data:` image, a foreign embed) is dropped on parse,
 * never escaped into text.
 */

export const CALLOUT_KINDS = ['info', 'warn', 'success', 'danger'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

export const EMBED_HOSTS: readonly string[] = [
  'figma.com',
  'www.figma.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'vimeo.com',
  'player.vimeo.com',
];

/** An https link on one of the embed hosts; anything else stays a plain link card. */
export function isEmbeddableUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && EMBED_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function calloutKind(raw: string | null): CalloutKind {
  return (CALLOUT_KINDS as readonly string[]).includes(raw ?? '') ? (raw as CalloutKind) : 'info';
}

/** `div[data-type=callout][data-kind]` — a tinted block holding ordinary blocks. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: 'info' satisfies CalloutKind,
        parseHTML: (el: HTMLElement) => calloutKind(el.getAttribute('data-kind')),
        renderHTML: (attrs: { kind?: string }) => ({
          'data-kind': calloutKind(attrs.kind ?? null),
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'callout' }, HTMLAttributes), 0];
  },
});

/** `div[data-type=embed][data-url]` — an atom; a URL off the host allowlist does not parse. */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      url: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-url'),
        renderHTML: (attrs: { url?: string | null }) => ({ 'data-url': attrs.url }),
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="embed"]',
        getAttrs: (el: HTMLElement) =>
          isEmbeddableUrl(el.getAttribute('data-url')) ? null : false,
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-type': 'embed' }, HTMLAttributes)];
  },
});

/** `mark[data-comment]` — the anchor of one comment thread on the selected text. */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-comment'),
        renderHTML: (attrs: { commentId?: string | null }) => ({ 'data-comment': attrs.commentId }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'mark[data-comment]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', HTMLAttributes, 0];
  },
});

export interface DocExtensionOptions {
  placeholder?: string;
  mentionSuggestion?: Partial<SuggestionOptions>;
}

export function docExtensions(opts: DocExtensionOptions = {}): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['mailto'],
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: false }),
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    Image.configure({ allowBase64: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Mention.configure({
      HTMLAttributes: { 'data-type': 'mention' },
      ...(opts.mentionSuggestion ? { suggestion: opts.mentionSuggestion } : {}),
    }),
    Callout,
    Embed,
    CommentMark,
    ...(opts.placeholder ? [Placeholder.configure({ placeholder: opts.placeholder })] : []),
  ];
}
