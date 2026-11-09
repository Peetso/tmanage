import { Extension, mergeAttributes, Mark, Node, type Extensions } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Mention from '@tiptap/extension-mention';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import TextAlign from '@tiptap/extension-text-align';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';

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
  // FIX2 item 9: Loom, the screen-recording video agencies send with briefs and reviews.
  'www.loom.com',
  'loom.com',
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

/**
 * The iframe address for an embeddable link (Figma / YouTube / Vimeo), or null. The stored body
 * keeps only `data-url`; the iframe exists in the browser's node view, never in the saved HTML.
 */
export function embedSrc(raw: string | null | undefined): string | null {
  if (!isEmbeddableUrl(raw)) return null;
  const url = new URL(raw as string);
  const host = url.hostname;
  if (host.endsWith('figma.com')) {
    return `https://www.figma.com/embed?embed_host=tmanage&url=${encodeURIComponent(url.href)}`;
  }
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0] ?? '';
    return /^[\w-]{6,20}$/u.test(id) ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host.endsWith('youtube.com')) {
    const id = url.searchParams.get('v') ?? url.pathname.split('/embed/')[1] ?? '';
    return /^[\w-]{6,20}$/u.test(id) ? `https://www.youtube.com/embed/${id}` : null;
  }
  if (host.endsWith('loom.com')) {
    const id = /^\/(?:share|embed)\/([0-9a-f]{20,40})/u.exec(url.pathname)?.[1];
    return id ? `https://www.loom.com/embed/${id}` : null;
  }
  const vimeo = /(\d{5,12})/u.exec(url.pathname)?.[1];
  return vimeo ? `https://player.vimeo.com/video/${vimeo}` : null;
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
  addNodeView() {
    return ({ node }) => {
      const url = String(node.attrs['url'] ?? '');
      const dom = document.createElement('div');
      dom.setAttribute('data-type', 'embed');
      dom.setAttribute('data-url', url);
      dom.setAttribute('contenteditable', 'false');
      const src = embedSrc(url);
      if (src) {
        const frame = document.createElement('iframe');
        frame.src = src;
        frame.title = new URL(url).hostname;
        frame.loading = 'lazy';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        frame.setAttribute(
          'sandbox',
          'allow-scripts allow-same-origin allow-popups allow-presentation',
        );
        dom.append(frame);
      }
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = url;
      dom.append(link);
      return { dom };
    };
  },
});

/** The image node with the uploaded file's id kept as `data-file-id` (same name, `image`). */
const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fileId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-file-id'),
        renderHTML: (attrs: { fileId?: string | null }) =>
          attrs.fileId ? { 'data-file-id': attrs.fileId } : {},
      },
    };
  },
});

/** The "/" menu: a Suggestion on "/" whose items and popup the editor supplies. */
export const SlashCommand = Extension.create<{ suggestion: Partial<SuggestionOptions> }>({
  name: 'slashCommand',
  addOptions() {
    return { suggestion: {} };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        char: '/',
        pluginKey: new PluginKey('slashCommand'),
        ...this.options.suggestion,
        editor: this.editor,
      }),
    ];
  },
});

/** The "#" work-item picker (A20): a Suggestion on "#" whose items, command and popup the editor supplies. */
export const WorkItemLink = Extension.create<{ suggestion: Partial<SuggestionOptions> }>({
  name: 'workItemLink',
  addOptions() {
    return { suggestion: {} };
  },
  addProseMirrorPlugins() {
    return [
      Suggestion({
        char: '#',
        pluginKey: new PluginKey('workItemLink'),
        ...this.options.suggestion,
        editor: this.editor,
      }),
    ];
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
  /** The "/" menu's items, command and popup (the editor only; the read view has none). */
  slashSuggestion?: Partial<SuggestionOptions>;
  /** The "#" work-item picker; it inserts a plain link, so the read view needs nothing. */
  workItemSuggestion?: Partial<SuggestionOptions>;
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
    DocImage.configure({ allowBase64: false }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Mention.configure({
      HTMLAttributes: { 'data-type': 'mention' },
      ...(opts.mentionSuggestion ? { suggestion: opts.mentionSuggestion } : {}),
    }),
    Callout,
    Embed,
    CommentMark,
    ...(opts.slashSuggestion ? [SlashCommand.configure({ suggestion: opts.slashSuggestion })] : []),
    ...(opts.workItemSuggestion
      ? [WorkItemLink.configure({ suggestion: opts.workItemSuggestion })]
      : []),
    ...(opts.placeholder ? [Placeholder.configure({ placeholder: opts.placeholder })] : []),
  ];
}
