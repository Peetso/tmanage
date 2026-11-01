import {
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import {
  ELEMENT_NODE,
  TEXT_NODE,
  attr,
  childrenOf,
  markdownToHtmlServer,
  parseHtmlFragment,
  safeHref,
  tagOf,
  textDirection,
  type DomNode,
  type ExportSource,
} from './document-export-html.js';

/**
 * R5 export (slice 5) — a document as a Word (.docx) file, built in-process with the MIT `docx`
 * package (no paid converter, no new process).
 *
 * A legacy Markdown body is first drawn as HTML by `markdownToHtmlServer`, so both formats walk
 * one DOM. Headings, paragraphs, bulleted/numbered lists, task items ("☐/☑ text"), tables, code
 * blocks, quotes/callouts, rules and links map to native Word structures; an image is its alt
 * text in italics for now (embedding the bytes needs the file store — later). A paragraph whose
 * text starts with a right-to-left character is `bidirectional`, so Arabic reads right to left.
 */

const HEADINGS = {
  h1: HeadingLevel.HEADING_1,
  h2: HeadingLevel.HEADING_2,
  h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4,
} as const;

interface RunStyle {
  readonly bold?: boolean;
  readonly italics?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly code?: boolean;
}

function run(text: string, style: RunStyle): TextRun {
  return new TextRun({
    text,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.underline ? { underline: {} } : {}),
    ...(style.code ? { font: 'Courier New' } : {}),
  });
}

/** The runs of an inline subtree, carrying bold/italic/underline/strike/code down. */
function runsOf(node: DomNode, style: RunStyle = {}): ParagraphChild[] {
  if (node.nodeType === TEXT_NODE) {
    const text = (node.textContent ?? '').replace(/\s+/gu, ' ');
    return text === '' ? [] : [run(text, style)];
  }
  if (node.nodeType !== ELEMENT_NODE) return [];
  const inner = (next: RunStyle) => childrenOf(node).flatMap((child) => runsOf(child, next));
  switch (tagOf(node)) {
    case 'strong':
    case 'b':
      return inner({ ...style, bold: true });
    case 'em':
    case 'i':
      return inner({ ...style, italics: true });
    case 'u':
      return inner({ ...style, underline: true });
    case 's':
      return inner({ ...style, strike: true });
    case 'code':
      return inner({ ...style, code: true });
    case 'br':
      return [new TextRun({ text: '', break: 1 })];
    case 'img':
      return [run(attr(node, 'alt') ?? '', { ...style, italics: true })];
    case 'a': {
      const href = safeHref(attr(node, 'href') ?? '');
      if (!href || href.startsWith('/')) return inner(style);
      return [
        new ExternalHyperlink({
          link: href,
          children: [
            new TextRun({
              text: node.textContent ?? href,
              style: 'Hyperlink',
              ...(style.bold ? { bold: true } : {}),
            }),
          ],
        }),
      ];
    }
    case 'span':
      if (attr(node, 'data-type') === 'mention') {
        return [run(`@${attr(node, 'data-label') ?? node.textContent ?? ''}`, style)];
      }
      return inner(style);
    case 'ul':
    case 'ol':
    case 'table':
      return [];
    default:
      return inner(style);
  }
}

function paragraph(
  node: DomNode,
  options: Omit<ConstructorParameters<typeof Paragraph>[0] & object, 'children'> = {},
  prefix: ParagraphChild[] = [],
): Paragraph {
  const text = node.textContent ?? '';
  return new Paragraph({
    ...options,
    ...(textDirection(text) === 'rtl' ? { bidirectional: true } : {}),
    children: [...prefix, ...runsOf(node)],
  });
}

function listItems(list: DomNode, level: number): (Paragraph | Table)[] {
  const ordered = tagOf(list) === 'ol';
  const out: (Paragraph | Table)[] = [];
  let index = 0;
  for (const item of childrenOf(list)) {
    if (tagOf(item) !== 'li') continue;
    index += 1;
    const task = attr(item, 'data-type') === 'taskItem';
    const nested = childrenOf(item).filter((child) => ['ul', 'ol'].includes(tagOf(child)));
    const marker = task
      ? `${attr(item, 'data-checked') === 'true' ? '☑' : '☐'} `
      : ordered
        ? `${index}. `
        : '';
    // A Tiptap item wraps its text in <p>; a markdown one is inline — runsOf skips nested lists.
    const prefix = marker === '' ? [] : [run(marker, {})];
    out.push(
      paragraph(
        item,
        marker === '' ? { bullet: { level } } : { indent: { start: 360 * (level + 1) } },
        prefix,
      ),
    );
    for (const child of nested) out.push(...listItems(child, level + 1));
  }
  return out;
}

function table(node: DomNode): Table | null {
  const rows: TableRow[] = [];
  const collect = (parent: DomNode) => {
    for (const child of childrenOf(parent)) {
      const tag = tagOf(child);
      if (tag === 'tr') {
        const cells = childrenOf(child)
          .filter((cell) => ['td', 'th'].includes(tagOf(cell)))
          .map((cell) => {
            const blocks = blocksOf(cell);
            return new TableCell({
              children: blocks.length > 0 ? blocks : [new Paragraph({ children: runsOf(cell) })],
            });
          });
        if (cells.length > 0) rows.push(new TableRow({ children: cells }));
      } else if (['thead', 'tbody', 'tfoot'].includes(tag)) collect(child);
    }
  };
  collect(node);
  return rows.length === 0
    ? null
    : new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

function blocksOf(container: DomNode): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const node of childrenOf(container)) {
    if (node.nodeType === TEXT_NODE) {
      if ((node.textContent ?? '').trim() !== '') out.push(paragraph(node));
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;
    const tag = tagOf(node);
    if (tag in HEADINGS) {
      out.push(paragraph(node, { heading: HEADINGS[tag as keyof typeof HEADINGS] }));
      continue;
    }
    switch (tag) {
      case 'p':
      case 'figcaption':
        out.push(paragraph(node));
        break;
      case 'ul':
      case 'ol':
        out.push(...listItems(node, 0));
        break;
      case 'table': {
        const built = table(node);
        if (built) out.push(built);
        break;
      }
      case 'pre': {
        const lines = (node.textContent ?? '').replace(/\n$/u, '').split('\n');
        out.push(
          new Paragraph({
            children: lines.map(
              (line, i) => new TextRun({ text: line, font: 'Courier New', break: i > 0 ? 1 : 0 }),
            ),
          }),
        );
        break;
      }
      case 'blockquote':
        for (const block of blocksOf(node)) out.push(block);
        break;
      case 'hr':
        out.push(new Paragraph({ thematicBreak: true, children: [] }));
        break;
      case 'img':
        out.push(new Paragraph({ children: runsOf(node) }));
        break;
      case 'div': {
        const type = attr(node, 'data-type');
        if (type === 'callout') {
          out.push(
            new Paragraph({ indent: { start: 360 }, children: [run('Note: ', { bold: true })] }),
          );
          out.push(...blocksOf(node));
        } else if (type === 'embed') {
          const url = safeHref(attr(node, 'data-url') ?? '');
          if (url && !url.startsWith('/')) {
            out.push(
              new Paragraph({
                children: [
                  new ExternalHyperlink({
                    link: url,
                    children: [new TextRun({ text: url, style: 'Hyperlink' })],
                  }),
                ],
              }),
            );
          }
        } else out.push(...blocksOf(node));
        break;
      }
      default:
        out.push(paragraph(node));
    }
  }
  return out;
}

/** Build the document as a `.docx` file: the title as a Title paragraph, then the body. */
export async function renderDocumentDocx(source: ExportSource): Promise<Buffer> {
  const html =
    (source.bodyFormat ?? 'markdown') === 'html' ? source.body : markdownToHtmlServer(source.body);
  const document = new Document({
    title: source.title,
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            ...(textDirection(source.title) === 'rtl' ? { bidirectional: true } : {}),
            children: [new TextRun(source.title)],
          }),
          ...blocksOf(parseHtmlFragment(html)),
        ],
      },
    ],
  });
  return Packer.toBuffer(document);
}
