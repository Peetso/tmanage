import { createRequire } from 'node:module';
import { ApiError } from '../../common/http/errors.js';
import type { PurifyHookData } from '../files/preview-generators/codecs.js';

/**
 * R5 slice 2 — the server half of the rich editor's safety (R5-SPEC §3).
 *
 * Every `html` save goes through {@link sanitizeDocHtml}: DOMPurify on one jsdom window (the
 * pattern of `files/preview-generators/codecs.ts`, but its own instance — the SVG generator adds
 * hooks to the shared one) with the SPEC §3 tag/attribute allowlist, plus a per-attribute policy for
 * the values the allowlist alone cannot judge: link targets, same-site image sources, the embed host
 * allowlist, `style` (text-align only) and `data-type` (per tag). What fails is dropped, never
 * escaped into text. The web editor's schema is the same set, so a body the editor wrote survives
 * unchanged.
 */

/** The longest stored body, input and sanitised output alike (`documents.body` is MEDIUMTEXT). */
export const MAX_BODY_LENGTH = 1_000_000;

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'p', 'br', 'strong', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'img',
  'span', 'mark', 'div', 'figure', 'figcaption',
]; // prettier-ignore

/** Which attribute each tag may carry; `*` applies to every tag. */
const ATTRS_BY_TAG: Readonly<Record<string, readonly string[]>> = {
  '*': ['dir', 'style'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'data-file-id'],
  ul: ['data-type'],
  li: ['data-type', 'data-checked'],
  span: ['data-type', 'data-id', 'data-label'],
  mark: ['data-comment'],
  div: ['data-type', 'data-kind', 'data-url'],
  td: ['colspan', 'rowspan', 'colwidth'],
  th: ['colspan', 'rowspan', 'colwidth'],
};
const ALLOWED_ATTR = [...new Set(Object.values(ATTRS_BY_TAG).flat())];

/** `data-type` values per tag. */
const DATA_TYPES: Readonly<Record<string, readonly string[]>> = {
  ul: ['taskList'],
  li: ['taskItem'],
  span: ['mention'],
  div: ['callout', 'embed'],
};

const EMBED_HOSTS = new Set([
  'figma.com', 'www.figma.com', 'youtube.com', 'www.youtube.com', 'youtu.be', 'vimeo.com',
  'player.vimeo.com',
]); // prettier-ignore

const TEXT_ALIGN = /^text-align:\s*(left|right|center|start|end|justify);?$/;
const SAFE_REL = 'noopener noreferrer';

function safeHref(value: string): boolean {
  if (value.startsWith('/')) return !value.startsWith('//') && !value.startsWith('/\\');
  return /^(https?:\/\/|mailto:)/i.test(value);
}

function safeImageSrc(value: string, orgSlug: string): boolean {
  const match = /^\/v1\/organizations\/([^/?#]+)\/files\/[A-Za-z0-9-]+\/content$/.exec(value);
  return match !== null && match[1] === encodeURIComponent(orgSlug);
}

function safeEmbedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && EMBED_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Whether one attribute value passes the policy for its tag. */
function keepAttribute(tag: string, name: string, value: string, orgSlug: string): boolean {
  const allowed = ATTRS_BY_TAG[tag] ?? [];
  if (!allowed.includes(name) && !(ATTRS_BY_TAG['*'] ?? []).includes(name)) return false;
  switch (name) {
    case 'href':
      return safeHref(value);
    case 'src':
      return safeImageSrc(value, orgSlug);
    case 'data-url':
      return safeEmbedUrl(value);
    case 'style':
      return TEXT_ALIGN.test(value.trim());
    case 'data-type':
      return (DATA_TYPES[tag] ?? []).includes(value);
    case 'target':
      return value === '_blank';
    case 'rel':
      return value === SAFE_REL;
    case 'dir':
      return value === 'ltr' || value === 'rtl' || value === 'auto';
    default:
      return true;
  }
}

interface HookElement {
  readonly nodeName: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

interface DocPurify {
  sanitize(source: string, config: Record<string, unknown>): string;
  addHook(
    hook: 'uponSanitizeAttribute' | 'afterSanitizeAttributes',
    run: (node: HookElement, data: PurifyHookData) => void,
  ): void;
}

const require = createRequire(import.meta.url);
let purify: DocPurify | undefined;
/** The tenant whose file URLs are same-site for the sanitize call in progress (sync, so safe). */
let currentOrgSlug = '';

function instance(): DocPurify {
  if (purify) return purify;
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => { window: object } };
  const createDOMPurify = require('dompurify') as (window: object) => DocPurify;
  const created = createDOMPurify(new JSDOM('').window);
  created.addHook('uponSanitizeAttribute', (node, data) => {
    const tag = node.nodeName.toLowerCase();
    if (!keepAttribute(tag, data.attrName, data.attrValue, currentOrgSlug)) data.keepAttr = false;
  });
  created.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.nodeName.toLowerCase();
    // An image whose source was refused is nothing; a new-tab link always gets the safe rel.
    if (tag === 'img' && !node.getAttribute('src')) node.remove();
    if (tag === 'a' && node.getAttribute('target')) node.setAttribute('rel', SAFE_REL);
  });
  purify = created;
  return created;
}

function invalid(message: string): ApiError {
  return new ApiError(
    422,
    'validation_failed',
    'The request body is invalid',
    [{ field: 'body', message }],
    'DOC_BODY_INVALID',
  );
}

/**
 * Sanitise an `html` document body for `orgSlug`. 422 `DOC_BODY_INVALID` when nothing survives a
 * non-empty input, or when the result is longer than {@link MAX_BODY_LENGTH}.
 */
export function sanitizeDocHtml(html: string, options: { readonly orgSlug: string }): string {
  const purifier = instance();
  currentOrgSlug = options.orgSlug;
  let clean: string;
  try {
    clean = purifier.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    });
  } finally {
    currentOrgSlug = '';
  }
  if (html.trim() !== '' && clean.trim() === '') throw invalid('has no allowed content');
  if (clean.length > MAX_BODY_LENGTH) {
    throw invalid(`must be ${MAX_BODY_LENGTH} characters or fewer`);
  }
  return clean;
}

const BLOCK_END =
  /<\/(p|h[1-3]|li|div|tr|blockquote|pre|figcaption|table)>|<br\s*\/?>|<hr\s*\/?>/gi;

/** The plain text of a (sanitised) HTML body: block ends become line breaks, tags are dropped. */
export function docHtmlToText(html: string): string {
  const { JSDOM } = require('jsdom') as {
    JSDOM: new (html: string) => { window: { document: { body: { textContent: string | null } } } };
  };
  const text = new JSDOM(`<!doctype html><body>${html.replace(BLOCK_END, (m) => `${m}\n`)}</body>`)
    .window.document.body.textContent;
  return (text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}
