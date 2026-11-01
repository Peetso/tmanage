import type JSZip from 'jszip';

/**
 * R4 slice 10 — the small shared half of the browser-side Office readers (Excel grid, PowerPoint
 * slides): open the package, read an XML part, resolve a relationship.
 *
 * Everything here runs in the viewer's browser on bytes fetched from the file's own content
 * route. Nothing from the file is ever put into the page as HTML: the readers produce plain
 * data, and React writes it as text.
 */

/** Parts larger than this are not read (a real sheet or slide part is far smaller). */
export const MAX_PART_BYTES = 16 * 1024 * 1024;

export async function openPackage(bytes: ArrayBuffer | Uint8Array): Promise<JSZip> {
  const { default: JSZipModule } = await import('jszip');
  return JSZipModule.loadAsync(bytes);
}

export async function readXml(zip: JSZip, path: string): Promise<Document | null> {
  const file = zip.file(path);
  if (!file) return null;
  const text = await file.async('string');
  if (text.length > MAX_PART_BYTES) return null;
  const document = new DOMParser().parseFromString(text, 'application/xml');
  return document.getElementsByTagName('parsererror').length > 0 ? null : document;
}

/** Children (any depth) with this local name, whatever the namespace prefix. */
export function all(root: Document | Element, localName: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', localName));
}

/** Direct children with this local name. */
export function children(parent: Element, localName: string): Element[] {
  return Array.from(parent.children).filter((child) => child.localName === localName);
}

export function child(parent: Element | null | undefined, localName: string): Element | null {
  if (!parent) return null;
  return Array.from(parent.children).find((node) => node.localName === localName) ?? null;
}

/** An attribute by local name (`r:id`, `r:embed` … whatever the prefix). */
export function attr(element: Element | null | undefined, localName: string): string | null {
  if (!element) return null;
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.localName === localName) return attribute.value;
  }
  return null;
}

const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * The `r:id` of an element. Looked up by namespace, because a slide id carries a plain `id` too
 * (`<p:sldId id="256" r:id="rId2"/>`).
 */
export function relationshipId(element: Element | null | undefined): string | null {
  if (!element) return null;
  return element.getAttributeNS(RELATIONSHIP_NS, 'id');
}

/** `ppt/slides/slide1.xml` + `../media/image1.png` → `ppt/media/image1.png`. */
export function resolvePath(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

/** The `_rels` file of a part: id → resolved target path (external targets left out). */
export async function relationships(zip: JSZip, part: string): Promise<Map<string, string>> {
  const slash = part.lastIndexOf('/');
  const relsPath = `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
  const xml = await readXml(zip, relsPath);
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const rel of all(xml, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target || rel.getAttribute('TargetMode') === 'External') continue;
    map.set(id, resolvePath(part, target));
  }
  return map;
}
