/**
 * 62-24 (plan 62 §4.5) — passages of a file's text, "by heading/page, 500 to 800 tokens".
 *
 * Tokens are estimated at 4 characters (Latin) — a passage aims at {@link TARGET_CHARS} and never
 * exceeds {@link MAX_CHARS}. A new passage starts at a heading (Markdown `#`) or a page marker the
 * extractor wrote (`Slide N`, `Sheet: …`) once the current one holds at least {@link MIN_CHARS};
 * a paragraph longer than the maximum is cut at a sentence end or a space. The page number is the
 * marker's (slides and sheets); a text without markers has none.
 */

export const TARGET_CHARS = 2_400;
export const MAX_CHARS = 3_200;
export const MIN_CHARS = 800;
/** Passages per file at most; the rest of a very long text is not indexed (said in the report). */
export const MAX_CHUNKS_PER_FILE = 400;

export interface TextChunk {
  readonly chunkNo: number;
  readonly pageNo: number | null;
  readonly body: string;
}

const PAGE_MARKER = /^(?:Slide \d+|Sheet: .+)$/;
const HEADING = /^#{1,6}\s/;
const ARABIC_QUESTION = `${String.fromCodePoint(0x61f)} `;

function pieces(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHARS) return [paragraph];
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS);
    const sentence = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
      window.lastIndexOf(ARABIC_QUESTION),
    );
    const cut = sentence > MIN_CHARS ? sentence + 1 : window.lastIndexOf(' ');
    const at = cut > MIN_CHARS ? cut : MAX_CHARS;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== '') out.push(rest);
  return out;
}

export function chunkText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let length = 0;
  let page: number | null = null;
  let currentPage: number | null = null;
  let pages = 0;

  const flush = () => {
    const body = current.join('\n\n').trim();
    if (body !== '' && chunks.length < MAX_CHUNKS_PER_FILE) {
      chunks.push({ chunkNo: chunks.length, pageNo: currentPage, body });
    }
    current = [];
    length = 0;
    currentPage = page;
  };

  for (const paragraph of text.split(/\n{2,}/)) {
    const firstLine = paragraph.split('\n', 1)[0] ?? '';
    const marker = PAGE_MARKER.test(firstLine);
    if (marker) {
      pages += 1;
      page = pages;
    }
    if ((marker || HEADING.test(firstLine)) && length >= MIN_CHARS) flush();
    if (current.length === 0) currentPage = page;
    for (const piece of pieces(paragraph.trim())) {
      if (piece === '') continue;
      if (length + piece.length > TARGET_CHARS && length > 0) flush();
      current.push(piece);
      length += piece.length + 2;
    }
  }
  flush();
  return chunks;
}
