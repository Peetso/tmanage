import { parseDocBlocks, safeHref } from '../DocMarkdown';

/**
 * A legacy Markdown body (the textarea era) as HTML for the rich editor — converted once, when
 * the document opens, and saved back as `html` on the next autosave (R5-SPEC §3). The blocks come
 * from the read view's own parser, so a body reads the same before and after the switch. Every
 * text run is escaped; only the five block kinds, bold, italic and safe links become tags.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

// [label](address) | **bold** | __bold__ | _italic_ | *italic* — as the read view's inline parser.
const INLINE =
  /\[([^\]]+)\]\(([^)\s]*)\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w])_([^_]+)_(?![\w])|\*([^*\s][^*]*)\*/gu;

function inlineHtml(text: string): string {
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    out += escapeHtml(text.slice(cursor, start));
    const [whole, label, address, bold, bold2, italic, italic2] = match;
    if (label !== undefined) {
      const href = safeHref(address ?? '');
      out += href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inlineHtml(label)}</a>`
        : escapeHtml(whole);
    } else if (bold !== undefined || bold2 !== undefined) {
      out += `<strong>${inlineHtml(bold ?? bold2 ?? '')}</strong>`;
    } else {
      out += `<em>${inlineHtml(italic ?? italic2 ?? '')}</em>`;
    }
    cursor = start + whole.length;
  }
  return out + escapeHtml(text.slice(cursor));
}

export function markdownToHtml(body: string): string {
  return parseDocBlocks(body)
    .map((block) => {
      switch (block.kind) {
        case 'heading':
          return `<h${block.level} dir="auto">${inlineHtml(block.text)}</h${block.level}>`;
        case 'bullets':
          return `<ul>${block.items.map((item) => `<li><p dir="auto">${inlineHtml(item)}</p></li>`).join('')}</ul>`;
        case 'numbers':
          return `<ol>${block.items.map((item) => `<li><p dir="auto">${inlineHtml(item)}</p></li>`).join('')}</ol>`;
        case 'checklist':
          return `<ul data-type="taskList">${block.items
            .map(
              (item) =>
                `<li data-type="taskItem" data-checked="${item.done ? 'true' : 'false'}"><p dir="auto">${inlineHtml(item.text)}</p></li>`,
            )
            .join('')}</ul>`;
        default:
          return `<p dir="auto">${inlineHtml(block.text)}</p>`;
      }
    })
    .join('');
}
