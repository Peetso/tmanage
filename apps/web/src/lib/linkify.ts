/** One piece of a plain-text body: text as is, or a safe http(s) link. */
export type LinkSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

const URL_PATTERN = /https?:\/\/[^\s<>()"'`…]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

function safeHref(candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname === '' ? null : parsed.href;
  } catch {
    return null;
  }
}

/**
 * Splits plain text into text and link segments. Only `http:`/`https:` URLs become links (no
 * `javascript:`, `data:` or bare hosts); trailing sentence punctuation stays text, and a URL cut
 * off by a truncation ellipsis ("…") is left as text, since its target is unknown.
 */
export function splitLinks(text: string): readonly LinkSegment[] {
  const segments: LinkSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const raw = match[0].replace(TRAILING_PUNCTUATION, '');
    const end = start + raw.length;
    const truncated = text.startsWith('…', start + match[0].length);
    const href = truncated ? null : safeHref(raw);
    if (href === null) continue;
    if (start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, start) });
    segments.push({ kind: 'link', text: raw, href });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

/** The first safe link of a body, or `null`. */
export function firstLink(text: string): string | null {
  for (const segment of splitLinks(text)) if (segment.kind === 'link') return segment.href;
  return null;
}
