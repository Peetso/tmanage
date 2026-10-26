/**
 * C6 — the server-side SVG sanitiser for the company logo.
 *
 * The file pipeline refuses SVG outright (`content-signature.ts`, SEC-06): an SVG is a document a
 * browser will run scripts in. The logo is the one place an SVG is wanted, so it is accepted only
 * after this module has **rebuilt** it from an allowlist: the input is tokenised, every element and
 * attribute is checked against the lists below, and a new document is written from what survives.
 * Nothing from the input is copied through unparsed, so a construct this tokeniser does not
 * understand is a refusal, never a pass.
 *
 * What is removed (with everything inside it, for elements):
 *
 * - `<script>`, `<foreignObject>`, animation elements (`<set>`/`<animate…>` can rewrite an `href`),
 *   and every element not on {@link ALLOWED_ELEMENTS} — including editor namespaces (`sodipodi:`,
 *   `inkscape:`) and `<a>`;
 * - every `on…` event-handler attribute and every attribute not on the allowlist;
 * - `href` / `xlink:href` that is not a same-document `#fragment` or an inline raster
 *   `data:image/(png|jpeg|gif|webp);base64,…` — no external reference survives;
 * - any `url(…)` in a presentation attribute, a `style` attribute or a `<style>` sheet that does not
 *   point at `#fragment`, plus `@import`, `expression(` and `javascript:` in CSS;
 * - comments, processing instructions and a DOCTYPE without an internal subset.
 *
 * What is refused (the caller answers with a clear message): markup the tokeniser cannot read, a
 * root that is not `<svg>`, a DOCTYPE with an internal subset (entity definitions), an entity other
 * than the five XML ones or a numeric reference, and a document with nothing left to draw.
 */

export type SvgSanitizeResult =
  | { readonly ok: true; readonly svg: string; readonly removed: readonly string[] }
  | { readonly ok: false; readonly reason: SvgRefusal };

export type SvgRefusal =
  | 'unreadable'
  | 'not_svg'
  | 'entity_definitions'
  | 'unknown_entity'
  | 'too_deep'
  | 'too_complex'
  | 'empty';

/** Elements that draw, group or define paint. Case-sensitive, as SVG is. */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'symbol',
  'use',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textPath',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'pattern',
  'image',
  'marker',
  'style',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feFlood',
  'feGaussianBlur',
  'feMerge',
  'feMergeNode',
  'feOffset',
  'feFuncA',
  'feFuncB',
  'feFuncG',
  'feFuncR',
  'feDropShadow',
  'feMorphology',
]);

/** Prefixed attributes that are kept. Every other prefixed attribute is dropped. */
const ALLOWED_PREFIXED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'xmlns:xlink',
  'xlink:href',
  'xml:space',
  'xml:lang',
]);

/** An unprefixed attribute name the sanitiser keeps (event handlers are refused separately). */
const PLAIN_ATTRIBUTE = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

/** The only `href` targets that survive: a same-document fragment or an inline raster image. */
const SAFE_HREF = /^(#[A-Za-z_][\w.:-]*|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+)$/;

/** Nesting limit — a logo has no reason to be deeper, and a bound keeps the work bounded. */
const MAX_DEPTH = 64;

/**
 * Size and element-count caps, checked before and during the rebuild (security audit NV14). The
 * route already caps the bytes at 512 KiB; the sanitiser repeats it in characters so it is never
 * handed more, and a logo has no reason to carry thousands of elements.
 */
export const SVG_MAX_INPUT_CHARS = 512 * 1024;
export const SVG_MAX_ELEMENTS = 10_000;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

class Refused extends Error {
  constructor(readonly reason: SvgRefusal) {
    super(reason);
  }
}

/** Decode the five XML entities and numeric references; anything else is a refusal. */
function decodeEntities(raw: string): string {
  return raw.replace(/&([^;\s&]{1,32});/g, (_match, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff)
        throw new Refused('unknown_entity');
      return String.fromCodePoint(code);
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff)
        throw new Refused('unknown_entity');
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[name];
    if (value === undefined) throw new Refused('unknown_entity');
    return value;
  });
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** CSS text inside a kept `<style>`: no markup, and `&` escaped so the output stays well-formed. */
function styleText(css: string): string {
  return css.replace(/</g, '').replace(/&/g, '&amp;');
}

/** A bare `&` that is not an entity is malformed XML. */
function assertNoBareAmpersand(raw: string): void {
  if (/&(?![^;\s&]{1,32};)/.test(raw)) throw new Refused('unreadable');
}

/** Whitespace as the regex class `\s` and `String.prototype.trim` see it. */
const WHITESPACE = /\s/;

/**
 * Whether the inside of one `url( … )` is a same-document reference: optional whitespace, an
 * optional quote, `#`, no quote or `)`, an optional quote, optional whitespace. A plain scan, so it
 * is linear in the argument (V1/NV14: the old anchored regex backtracked on long whitespace runs).
 */
function isFragmentUrlArgument(argument: string): boolean {
  let value = argument.trim();
  if (value.startsWith("'") || value.startsWith('"')) value = value.slice(1);
  if (value.endsWith("'") || value.endsWith('"')) value = value.slice(0, -1);
  return value.startsWith('#') && !value.includes("'") && !value.includes('"');
}

/**
 * Whether CSS text is free of external references and script; `url(#id)` is the one url kept.
 * Linear in the text (V1/NV14): every `url(` is found with `indexOf`, its argument is read up to
 * the next `)`, and the scan resumes after that `)` — the old `/url\s*\(([^)]*)\)/g` rescanned to
 * the end from every `url(` that had no `)`. A `url(` with no `)` is refused: CSS closes an
 * unterminated url at the end of the sheet, so it would still be fetched.
 */
function isSafeCss(css: string): boolean {
  const lower = css.toLowerCase().replace(/\\/g, '');
  if (lower.includes('@import') || lower.includes('expression(')) return false;
  if (
    lower.includes('javascript:') ||
    lower.includes('behavior:') ||
    lower.includes('-moz-binding')
  )
    return false;
  let from = 0;
  for (;;) {
    const at = lower.indexOf('url', from);
    if (at === -1) return true;
    let open = at + 3;
    while (open < lower.length && WHITESPACE.test(lower[open] as string)) open += 1;
    if (lower[open] !== '(') {
      from = at + 3;
      continue;
    }
    const close = lower.indexOf(')', open + 1);
    if (close === -1) return false;
    if (!isFragmentUrlArgument(lower.slice(open + 1, close))) return false;
    from = close + 1;
  }
}

interface Attribute {
  readonly name: string;
  readonly value: string;
}

/** Parse `name="value"` pairs. Unquoted values or stray characters make the tag unreadable. */
function parseAttributes(source: string): Attribute[] {
  const attributes: Attribute[] = [];
  const pattern = /\s*([^\s=/>"']+)\s*=\s*("([^"<]*)"|'([^'<]*)')/y;
  // Sticky, so the trailing-whitespace check reads from `index` without copying the rest (NV14).
  const trailing = /\s*$/y;
  let index = 0;
  while (index < source.length) {
    trailing.lastIndex = index;
    if (trailing.test(source)) break;
    pattern.lastIndex = index;
    const match = pattern.exec(source);
    if (!match) throw new Refused('unreadable');
    const raw = match[3] ?? match[4] ?? '';
    assertNoBareAmpersand(raw);
    attributes.push({ name: match[1] as string, value: decodeEntities(raw) });
    index = pattern.lastIndex;
  }
  return attributes;
}

/** The attribute decision. `null` drops it; the reason goes to `removed`. */
function keepAttribute(element: string, attribute: Attribute, removed: string[]): Attribute | null {
  const name = attribute.name;
  const lowerName = name.toLowerCase();
  const value = attribute.value;
  if (lowerName.startsWith('on')) {
    removed.push(`event handler ${name}`);
    return null;
  }
  if (name === 'xmlns') {
    return value === 'http://www.w3.org/2000/svg' ? attribute : null;
  }
  if (name.includes(':')) {
    if (!ALLOWED_PREFIXED_ATTRIBUTES.has(name)) {
      removed.push(`attribute ${name}`);
      return null;
    }
    if (name === 'xmlns:xlink') {
      return value === 'http://www.w3.org/1999/xlink' ? attribute : null;
    }
  } else if (!PLAIN_ATTRIBUTE.test(name)) {
    removed.push(`attribute ${name}`);
    return null;
  }
  if (lowerName === 'href' || lowerName === 'xlink:href') {
    if (!SAFE_HREF.test(value.trim())) {
      removed.push(`external reference on <${element}>`);
      return null;
    }
    return { name, value: value.trim() };
  }
  // Drop whitespace and C0 control characters, which browsers ignore inside a URL scheme.
  const compact = Array.from(value.toLowerCase())
    .filter((ch) => ch.charCodeAt(0) > 0x1f && !/\s/.test(ch))
    .join('');
  if (
    compact.includes('javascript:') ||
    compact.includes('vbscript:') ||
    compact.includes('data:')
  ) {
    removed.push(`attribute ${name}`);
    return null;
  }
  if ((lowerName === 'style' || compact.includes('url(')) && !isSafeCss(value)) {
    removed.push(`external reference in ${name}`);
    return null;
  }
  return attribute;
}

interface Frame {
  readonly name: string;
  /** False when this element (or an ancestor) was dropped: nothing inside it is written. */
  readonly kept: boolean;
  /**
   * For a kept `<style>`: the index in the output chunk array of its start tag and of its sheet's
   * first chunk (V1/NV14: chunk indexes, so judging or dropping a sheet never copies the output
   * written before it).
   */
  readonly outStart?: number;
  readonly contentStart?: number;
}

/**
 * Sanitise an SVG document. On success `svg` is the rebuilt document (UTF-8 text) and `removed`
 * names what was stripped — empty when the input was already clean.
 */
export function sanitizeSvg(input: string): SvgSanitizeResult {
  try {
    return { ok: true, ...rebuild(input) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: error.reason };
    throw error;
  }
}

function rebuild(input: string): { svg: string; removed: string[] } {
  if (input.length > SVG_MAX_INPUT_CHARS) throw new Refused('too_complex');
  const source = input.replace(/^\uFEFF/, '');
  const removed: string[] = [];
  const stack: Frame[] = [];
  // The output as chunks, joined once at the end (V1/NV14): appending never re-copies what was
  // written before, and a dropped <style> is cut by truncating the array to its start-tag index.
  const out: string[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let drawn = 0;
  let elements = 0;
  let index = 0;

  const insideKept = () => stack.length === 0 || (stack[stack.length - 1] as Frame).kept;
  const insideStyle = () => stack.length > 0 && (stack[stack.length - 1] as Frame).name === 'style';

  while (index < source.length) {
    const lt = source.indexOf('<', index);
    const textEnd = lt === -1 ? source.length : lt;
    if (textEnd > index) {
      const raw = source.slice(index, textEnd);
      if (stack.length === 0) {
        if (raw.trim() !== '') throw new Refused('unreadable');
      } else {
        assertNoBareAmpersand(raw);
        const text = decodeEntities(raw);
        if (insideKept()) out.push(insideStyle() ? styleText(text) : escapeText(text));
      }
      index = textEnd;
      continue;
    }

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      if (end === -1) throw new Refused('unreadable');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9);
      if (end === -1 || stack.length === 0) throw new Refused('unreadable');
      if (insideKept()) {
        const text = source.slice(index + 9, end);
        out.push(insideStyle() ? styleText(text) : escapeText(text));
      }
      index = end + 3;
      continue;
    }
    if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index + 2);
      if (end === -1) throw new Refused('unreadable');
      index = end + 2;
      continue;
    }
    if (source.startsWith('<!', index)) {
      const end = source.indexOf('>', index + 2);
      if (end === -1) throw new Refused('unreadable');
      const declaration = source.slice(index, end + 1);
      if (!/^<!DOCTYPE\s/i.test(declaration) || stack.length > 0 || rootSeen) {
        throw new Refused('unreadable');
      }
      if (declaration.includes('[')) throw new Refused('entity_definitions');
      index = end + 1;
      continue;
    }
    if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index + 2);
      if (end === -1) throw new Refused('unreadable');
      const name = source.slice(index + 2, end).trim();
      const frame = stack.pop();
      if (!frame || frame.name !== name) throw new Refused('unreadable');
      if (frame.kept && frame.outStart !== undefined && frame.contentStart !== undefined) {
        // A <style> sheet is judged when it closes, from its own chunks only (NV14/V1: no pass
        // over, and no copy of, the whole output). One with an external reference is dropped whole.
        if (isSafeCss(out.slice(frame.contentStart).join(''))) {
          out.push(`</${name}>`);
        } else {
          out.length = frame.outStart;
          removed.push('external reference in <style>');
        }
      } else if (frame.kept) {
        out.push(`</${name}>`);
      }
      if (stack.length === 0) rootClosed = true;
      index = end + 1;
      continue;
    }

    // A start tag. Find its end outside quoted values.
    let cursor = index + 1;
    let quote: string | null = null;
    while (cursor < source.length) {
      const ch = source[cursor] as string;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      } else if (ch === '<') {
        throw new Refused('unreadable');
      }
      cursor += 1;
    }
    if (cursor >= source.length) throw new Refused('unreadable');
    let body = source.slice(index + 1, cursor);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const nameMatch = /^([A-Za-z_][\w.:-]*)/.exec(body);
    if (!nameMatch) throw new Refused('unreadable');
    const name = nameMatch[1] as string;
    const attributes = parseAttributes(body.slice(name.length));

    if (stack.length === 0) {
      if (rootSeen || rootClosed) throw new Refused('unreadable');
      if (name !== 'svg') throw new Refused('not_svg');
      rootSeen = true;
    }
    if (stack.length >= MAX_DEPTH) throw new Refused('too_deep');
    elements += 1;
    if (elements > SVG_MAX_ELEMENTS) throw new Refused('too_complex');

    const parentKept = insideKept();
    const allowed = ALLOWED_ELEMENTS.has(name);
    if (parentKept && !allowed) removed.push(`<${name}>`);
    const kept = parentKept && allowed;
    let outStart = out.length;
    if (kept) {
      const keptAttributes = attributes
        .map((attribute) => keepAttribute(name, attribute, removed))
        .filter((attribute): attribute is Attribute => attribute !== null);
      if (name === 'svg' && stack.length === 0 && !keptAttributes.some((a) => a.name === 'xmlns')) {
        keptAttributes.unshift({ name: 'xmlns', value: 'http://www.w3.org/2000/svg' });
      }
      if (
        name !== 'svg' &&
        name !== 'style' &&
        name !== 'defs' &&
        name !== 'title' &&
        name !== 'desc'
      ) {
        drawn += 1;
      }
      const rendered = keptAttributes
        .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
        .join('');
      // An empty, self-closing <style/> holds no sheet: it is not written at all.
      if (!(selfClosing && name === 'style')) {
        outStart = out.length;
        out.push(`<${name}${rendered}${selfClosing ? '/>' : '>'}`);
      }
    }
    if (selfClosing) {
      if (stack.length === 0) rootClosed = true;
    } else if (kept && name === 'style') {
      stack.push({ name, kept, outStart, contentStart: out.length });
    } else {
      stack.push({ name, kept });
    }
    index = cursor + 1;
  }

  if (!rootSeen) throw new Refused('not_svg');
  if (stack.length > 0 || !rootClosed) throw new Refused('unreadable');

  if (drawn === 0) throw new Refused('empty');
  return { svg: out.join(''), removed };
}
