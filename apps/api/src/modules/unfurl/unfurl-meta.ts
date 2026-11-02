/**
 * R20-a (54-09 Phase 0) — the pure half of the unfurl proxy: which links may be previewed, and how
 * a fetched page or oEmbed answer becomes a preview card. No I/O here; `unfurl.service.ts` owns the
 * fetch, the caps, the cache and the throttle.
 *
 * ## The allow-list is exact
 *
 * `UNFURL_HOSTS` names whole hostnames. There is no suffix match, so `evil.figma.com` and
 * `figma.com.evil.net` are both refused, and only `https:` on the default port with no userinfo
 * passes. A refusal here happens before any DNS lookup or fetch — the proxy can never be pointed at
 * a host this table does not name.
 */
import { figmaOpenUrl, parseFigmaUrl } from '../figma/figma.rest.js';

export type UnfurlProvider = 'figma' | 'github' | 'google_docs' | 'onedrive';

/** Exact, lower-cased hostnames → provider. Nothing else is ever fetched. */
export const UNFURL_HOSTS: Readonly<Record<string, UnfurlProvider>> = Object.freeze({
  'www.figma.com': 'figma',
  'figma.com': 'figma',
  'github.com': 'github',
  'docs.google.com': 'google_docs',
  'onedrive.live.com': 'onedrive',
});

export const UNFURL_MAX_URL_CHARS = 2048;
/** The read cap: a longer body is truncated, not refused (og tags live in the head). */
export const UNFURL_MAX_BYTES = 512 * 1024;
export const UNFURL_TIMEOUT_MS = 5_000;
export const UNFURL_TITLE_CHARS = 200;
export const UNFURL_DESCRIPTION_CHARS = 500;

/** Figma's public oEmbed endpoint (the only provider here that publishes one). */
export const FIGMA_OEMBED_ENDPOINT = 'https://www.figma.com/api/oembed';

export interface UnfurlCard {
  readonly provider: UnfurlProvider;
  readonly url: string;
  readonly title: string;
  readonly description: string | null;
  readonly thumbnailUrl: string | null;
  readonly openUrl: string;
}

export type NormalisedUnfurlUrl =
  | { readonly url: string; readonly provider: UnfurlProvider }
  | { readonly reason: 'invalid_url' | 'host_not_allowed' };

/**
 * A raw `?url=` → the URL to fetch and its provider, or the one refusal token. The fragment is
 * dropped (never sent to a server anyway); the query is kept — a Figma node id lives there.
 */
export function normaliseUnfurlUrl(raw: unknown): NormalisedUnfurlUrl {
  if (typeof raw !== 'string') return { reason: 'invalid_url' };
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > UNFURL_MAX_URL_CHARS) return { reason: 'invalid_url' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') return { reason: 'host_not_allowed' };
  if (url.username !== '' || url.password !== '') return { reason: 'host_not_allowed' };
  // WHATWG URL already blanks the default port (`:443`), so any port left is a non-default one.
  if (url.port !== '') return { reason: 'host_not_allowed' };
  const host = url.hostname.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(UNFURL_HOSTS, host)) {
    return { reason: 'host_not_allowed' };
  }
  const provider = UNFURL_HOSTS[host] as UnfurlProvider;
  url.hash = '';
  const normalised = url.toString();
  if (normalised.length > UNFURL_MAX_URL_CHARS) return { reason: 'invalid_url' };
  return { url: normalised, provider };
}

/** The "Open" link a card carries: Figma's canonical design link when the URL names a file. */
export function unfurlOpenUrl(url: string, provider: UnfurlProvider): string {
  if (provider === 'figma') {
    const parsed = parseFigmaUrl(url);
    if (parsed) return figmaOpenUrl(parsed.fileKey, parsed.nodeId);
  }
  return url;
}

/** The oEmbed request for one Figma link. */
export function figmaOembedUrl(url: string): string {
  return `${FIGMA_OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}`;
}

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/gu, (entity) => ENTITIES[entity] ?? entity);
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/** Entities decoded, whitespace collapsed, clipped; empty is null. */
function cleanText(raw: string | null | undefined, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const text = decodeEntities(raw).replace(/\s+/gu, ' ').trim();
  return text === '' ? null : clip(text, max);
}

/** An image link is kept only when it is an absolute https URL. */
function httpsOnly(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = decodeEntities(raw).trim();
  if (value === '' || value.length > UNFURL_MAX_URL_CHARS) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const META_TAG = /<meta\b[^>]*>/giu;
const ATTRIBUTE = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gu;
const TITLE_TAG = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu;

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!found.has(name)) found.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}

export interface HtmlMeta {
  readonly title: string | null;
  readonly description: string | null;
  readonly imageUrl: string | null;
}

/** `og:title` / `og:description` / `og:image`, then `<title>`, from the first 512 KiB only. */
export function parseHtmlMeta(html: string): HtmlMeta {
  const head = html.length > UNFURL_MAX_BYTES ? html.slice(0, UNFURL_MAX_BYTES) : html;
  const og = new Map<string, string>();
  for (const match of head.matchAll(META_TAG)) {
    const attrs = attributes(match[0]);
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (
      content !== undefined &&
      (key === 'og:title' || key === 'og:description' || key === 'og:image') &&
      !og.has(key)
    ) {
      og.set(key, content);
    }
  }
  const titleTag = TITLE_TAG.exec(head)?.[1];
  return {
    title:
      cleanText(og.get('og:title'), UNFURL_TITLE_CHARS) ?? cleanText(titleTag, UNFURL_TITLE_CHARS),
    description: cleanText(og.get('og:description'), UNFURL_DESCRIPTION_CHARS),
    imageUrl: httpsOnly(og.get('og:image')),
  };
}

export interface OembedCardFields {
  readonly title: string | null;
  readonly thumbnailUrl: string | null;
}

/** Figma's oEmbed JSON → title and an https-only thumbnail; `provider_name` is ignored. */
export function oembedToCard(json: unknown): OembedCardFields | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;
  return {
    title: cleanText(
      typeof record['title'] === 'string' ? record['title'] : null,
      UNFURL_TITLE_CHARS,
    ),
    thumbnailUrl: httpsOnly(record['thumbnail_url']),
  };
}

/** The card's title when the page names none: the host, so the card is never blank. */
export function fallbackTitle(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
