import { createRequire } from 'node:module';

/**
 * 54-15 — the XML half of SAML sign-in: a strict parser and Exclusive XML Canonicalization 1.0
 * (`http://www.w3.org/2001/10/xml-exc-c14n#`, without comments), the only canonicalization the
 * response verifier accepts.
 *
 * - **Parsing** uses the jsdom XML parser already in the api's dependencies. A document type
 *   declaration or an entity declaration is refused before parsing (no internal entities, no
 *   external ones, no expansion attacks); so is a document the parser flags as malformed.
 * - **Canonicalization** renders one element subtree as the specification's octet stream:
 *   namespace declarations only where visibly used (or listed in the InclusiveNamespaces prefix
 *   list) and not already rendered by an output ancestor, attributes sorted by namespace URI then
 *   local name, the fixed escaping of text and attribute values, empty elements as start/end
 *   pairs, comments dropped. One subtree (the enveloped signature) may be left out.
 *
 * The api compiles without the DOM lib, so the node shapes it reads are declared here.
 */

export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
const MAX_XML_CHARS = 512 * 1024;

const ELEMENT = 1;
const TEXT = 3;
const CDATA = 4;
const PROCESSING_INSTRUCTION = 7;
const COMMENT = 8;

export interface XmlAttr {
  readonly name: string;
  readonly localName: string;
  readonly prefix: string | null;
  readonly namespaceURI: string | null;
  readonly value: string;
}

export interface XmlNode {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<XmlNode>;
}

export interface XmlElement extends XmlNode {
  readonly tagName: string;
  readonly localName: string;
  readonly prefix: string | null;
  readonly namespaceURI: string | null;
  readonly attributes: ArrayLike<XmlAttr>;
  getAttribute(name: string): string | null;
  lookupNamespaceURI(prefix: string | null): string | null;
}

interface ProcessingInstruction extends XmlNode {
  readonly target: string;
  readonly data: string;
}

interface XmlDocument {
  readonly documentElement: XmlElement | null;
  getElementsByTagName(name: string): ArrayLike<XmlElement>;
}

interface Window {
  DOMParser: new () => { parseFromString(text: string, type: string): XmlDocument };
}

export class XmlRejectedError extends Error {
  override name = 'XmlRejectedError';
  constructor(readonly reason: 'too_large' | 'doctype' | 'malformed') {
    super(`XML rejected: ${reason}`);
  }
}

const require = createRequire(import.meta.url);
let window: Window | undefined;

function parserWindow(): Window {
  if (window) return window;
  const { JSDOM } = require('jsdom') as { JSDOM: new (html: string) => { window: Window } };
  window = new JSDOM('').window;
  return window;
}

/** The document element of `text`, or {@link XmlRejectedError}. */
export function parseStrictXml(text: string): XmlElement {
  if (text.length > MAX_XML_CHARS) throw new XmlRejectedError('too_large');
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new XmlRejectedError('doctype');
  const win = parserWindow();
  const document = new win.DOMParser().parseFromString(text, 'application/xml');
  const root = document.documentElement;
  if (!root || document.getElementsByTagName('parsererror').length > 0) {
    throw new XmlRejectedError('malformed');
  }
  return root;
}

export function isElement(node: XmlNode): node is XmlElement {
  return node.nodeType === ELEMENT;
}

/** The direct element children of `parent` named `{ns}local`. */
export function childElements(parent: XmlElement, ns: string, local: string): XmlElement[] {
  return Array.from(parent.childNodes).filter(
    (node): node is XmlElement =>
      isElement(node) && node.namespaceURI === ns && node.localName === local,
  );
}

/** Every element of the subtree (the root included), document order. */
export function descendants(root: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (element: XmlElement) => {
    out.push(element);
    for (const child of Array.from(element.childNodes)) if (isElement(child)) walk(child);
  };
  walk(root);
  return out;
}

/**
 * 56-10s — whether the subtree holds a comment or a processing instruction. Exclusive C14N drops
 * comments, so one inserted into a signed value (`user@evil.com<!---->.good.com`) leaves the digest
 * intact while splitting the text a reader sees; the verifier refuses such an assertion outright.
 */
export function hasCommentOrInstruction(root: XmlElement): boolean {
  const walk = (node: XmlNode): boolean =>
    Array.from(node.childNodes).some(
      (child) =>
        child.nodeType === COMMENT ||
        child.nodeType === PROCESSING_INSTRUCTION ||
        (isElement(child) && walk(child)),
    );
  return walk(root);
}

const escapeText = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\r/gu, '&#xD;');

const escapeAttribute = (value: string): string =>
  value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/"/gu, '&quot;')
    .replace(/\t/gu, '&#x9;')
    .replace(/\n/gu, '&#xA;')
    .replace(/\r/gu, '&#xD;');

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Exclusive canonicalization of `root`'s subtree, `exclude` (and everything under it) left out.
 * `inclusivePrefixes` is the InclusiveNamespaces PrefixList (`#default` for the default one).
 */
export function exclusiveCanonicalize(
  root: XmlElement,
  options: { readonly exclude?: XmlElement; readonly inclusivePrefixes?: readonly string[] } = {},
): string {
  const inclusive = (options.inclusivePrefixes ?? []).map((p) => (p === '#default' ? '' : p));
  const parts: string[] = [];

  const render = (element: XmlElement, rendered: ReadonlyMap<string, string>): void => {
    const used = new Map<string, string>();
    used.set(element.prefix ?? '', element.namespaceURI ?? '');
    const attributes: XmlAttr[] = [];
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.namespaceURI === XMLNS_NS) continue;
      attributes.push(attribute);
      if (attribute.prefix && attribute.prefix !== 'xml') {
        used.set(attribute.prefix, attribute.namespaceURI ?? '');
      }
    }
    for (const prefix of inclusive) {
      if (used.has(prefix)) continue;
      const uri = element.lookupNamespaceURI(prefix === '' ? null : prefix);
      if (uri !== null) used.set(prefix, uri);
    }
    const next = new Map(rendered);
    const declarations: [string, string][] = [];
    for (const [prefix, uri] of used) {
      if ((rendered.get(prefix) ?? '') === uri && (prefix === '' || rendered.has(prefix))) continue;
      if (prefix !== '' && uri === '') continue;
      declarations.push([prefix, uri]);
      next.set(prefix, uri);
    }
    declarations.sort(([a], [b]) => byCodePoint(a, b));
    attributes.sort(
      (a, b) =>
        byCodePoint(a.namespaceURI ?? '', b.namespaceURI ?? '') ||
        byCodePoint(a.localName, b.localName),
    );
    parts.push(`<${element.tagName}`);
    for (const [prefix, uri] of declarations) {
      parts.push(
        prefix === ''
          ? ` xmlns="${escapeAttribute(uri)}"`
          : ` xmlns:${prefix}="${escapeAttribute(uri)}"`,
      );
    }
    for (const attribute of attributes) {
      parts.push(` ${attribute.name}="${escapeAttribute(attribute.value)}"`);
    }
    parts.push('>');
    for (const child of Array.from(element.childNodes)) {
      if (isElement(child)) {
        if (child !== options.exclude) render(child, next);
      } else if (child.nodeType === TEXT || child.nodeType === CDATA) {
        parts.push(escapeText(child.nodeValue ?? ''));
      } else if (child.nodeType === PROCESSING_INSTRUCTION) {
        const pi = child as ProcessingInstruction;
        parts.push(`<?${pi.target}${pi.data ? ` ${pi.data}` : ''}?>`);
      } else if (child.nodeType !== COMMENT) {
        throw new XmlRejectedError('malformed');
      }
    }
    parts.push(`</${element.tagName}>`);
  };

  render(root, new Map());
  return parts.join('');
}
