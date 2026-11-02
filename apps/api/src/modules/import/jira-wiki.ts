/**
 * R22-e (54-27) — Jira wiki markup → Markdown, pure and bounded.
 *
 * A Jira "All fields" CSV export carries descriptions in Jira's wiki markup (the REST path
 * carries ADF, see jira-adf.ts). This converts the common subset:
 *
 * `h1.`–`h6.`, `*bold*`, `_em_`, `{{mono}}`, `-strike-`, `+under+` (→ `__`), `[text|url]` /
 * `[url]` (only `http(s):` / `mailto:` stay links), `*` / `#` lists nested by repetition,
 * `{code:lang}…{code}` / `{noformat}…{noformat}` → fences, `{quote}…{quote}` / `bq.`,
 * `||h||` + `|c|` tables, `----`, `!image.png|thumbnail!` → `[attachment: image.png]`;
 * `{color:…}` and `{panel…}` are unwrapped. Any other `{macro}` keeps its body and its name is
 * recorded once in `unknownMacros`.
 *
 * Plain text — Arabic included — passes through byte-identical: every rule needs its markup.
 */

import { ADF_DEFAULT_LIMITS, cutTo, safeHref } from './jira-adf.js';

export interface WikiResult {
  readonly markdown: string;
  readonly unknownMacros: readonly string[];
  readonly truncated: boolean;
}

/** Placeholder delimiters: control characters a Jira text never carries. */
const PH_OPEN = '\u0000';
const PH_CLOSE = '\u0001';
const QUOTE_MARK = `${PH_OPEN}Q${PH_CLOSE}`;

const UNWRAPPED = new Set(['color', 'panel']);

/** The input bound before any regex runs: a description is `TEXT`-sized. */
const MAX_INPUT = 200_000;

export function wikiToMarkdown(
  input: string,
  maxChars: number = ADF_DEFAULT_LIMITS.maxChars,
): WikiResult {
  const unknown = new Set<string>();
  const held: string[] = [];
  const hold = (text: string) => `${PH_OPEN}${held.push(text) - 1}${PH_CLOSE}`;

  // eslint-disable-next-line no-control-regex
  let text = input.slice(0, MAX_INPUT).replace(/[\u0000\u0001]/gu, '');
  text = text.replace(/\r\n?/gu, '\n');

  // 1. Code and noformat blocks: their bodies are verbatim, so they are held aside first.
  text = text.replace(
    /\{(code|noformat)(?::([^}\n]*))?\}([\s\S]*?)(?:\{\1\}|$(?![\s\S]))/gu,
    (_m, _kind: string, params: string | undefined, body: string) => {
      const lang = codeLanguage(params);
      const trimmed = body.replace(/^\n/u, '').replace(/\n$/u, '');
      const fence = trimmed.includes('```') ? '~~~~' : '```';
      return `\n${hold(`${fence}${lang}\n${trimmed}\n${fence}`)}\n`;
    },
  );

  // 2. Block macros: quote toggles, unwrapped panels / colors, unknown macros keep their body.
  text = text.replace(/\{quote\}/gu, `\n${QUOTE_MARK}\n`);
  text = text.replace(/(?<!\{)\{([A-Za-z][\w-]*)(?::[^}\n]*)?\}(?!\})/gu, (_m, name: string) => {
    const lower = name.toLowerCase();
    if (UNWRAPPED.has(lower)) return lower === 'panel' ? '\n' : '';
    if (unknown.size < 50) unknown.add(lower.slice(0, 60));
    return '';
  });

  // 3. Lines.
  const out: string[] = [];
  let inQuote = false;
  let tableRows = 0;
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === QUOTE_MARK) {
      inQuote = !inQuote;
      tableRows = 0;
      continue;
    }
    let line = convertLine(rawLine, hold);
    const table = tableLine(line);
    if (table !== null) {
      const cells = table.cells;
      const row = `| ${cells.join(' | ')} |`;
      if (tableRows === 0) {
        out.push(prefix(row, inQuote), prefix(`|${' --- |'.repeat(cells.length)}`, inQuote));
      } else {
        out.push(prefix(row, inQuote));
      }
      tableRows += 1;
      continue;
    }
    tableRows = 0;
    line = blockLine(line);
    out.push(prefix(line, inQuote));
  }

  let markdown = out
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const restore = new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'gu');
  // Held text may hold another placeholder (a `{{mono}}` inside a link label): bounded passes.
  for (let pass = 0; pass < 3 && markdown.includes(PH_OPEN); pass += 1) {
    markdown = markdown.replace(restore, (_m, index: string) => held[Number(index)] ?? '');
  }
  const cut = cutTo(markdown, maxChars);
  return {
    markdown: cut,
    unknownMacros: [...unknown],
    truncated: cut !== markdown || input.length > MAX_INPUT,
  };
}

function prefix(line: string, inQuote: boolean): string {
  if (!inQuote) return line;
  return line === '' ? '>' : `> ${line}`;
}

function codeLanguage(params: string | undefined): string {
  if (params === undefined) return '';
  for (const part of params.split('|')) {
    const value = part.includes('=')
      ? part.toLowerCase().startsWith('language=')
        ? part.slice('language='.length)
        : ''
      : part;
    const lang = value.trim().replace(/[^\w+#.-]/gu, '');
    if (lang !== '') return lang;
  }
  return '';
}

/** Headings, quotes, rules and lists — the line-start forms. */
function blockLine(line: string): string {
  const heading = /^\s*h([1-6])\.\s+(.*)$/u.exec(line);
  if (heading) return `${'#'.repeat(Number(heading[1]))} ${heading[2] ?? ''}`;
  const bq = /^\s*bq\.\s+(.*)$/u.exec(line);
  if (bq) return `> ${bq[1] ?? ''}`;
  if (/^\s*-{4,}\s*$/u.test(line)) return '---';
  const list = /^\s*([*#]+)\s+(.*)$/u.exec(line);
  if (list) {
    const markers = list[1] ?? '';
    const indent = '  '.repeat(markers.length - 1);
    const bullet = markers.endsWith('#') ? '1.' : '-';
    return `${indent}${bullet} ${list[2] ?? ''}`;
  }
  return line;
}

/** A `||h||h||` header or `|c|c|` row, after inline conversion removed link / image pipes. */
function tableLine(line: string): { cells: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || trimmed.length < 2) return null;
  const body = trimmed.replace(/^\|\|?/u, '').replace(/\|\|?$/u, '');
  const cells = body.split(/\|\|?/u).map((c) => c.trim());
  return { cells };
}

/** Inline markup on one line; code spans and links are held so later rules cannot touch them. */
function convertLine(line: string, hold: (text: string) => string): string {
  let out = line;
  // {{mono}}
  out = out.replace(/\{\{([^\n]+?)\}\}/gu, (_m, code: string) =>
    hold(code.includes('`') ? `\`\` ${code} \`\`` : `\`${code}\``),
  );
  // !image.png|thumbnail! → an attachment reference.
  out = out.replace(/!([^\s!|]+\.[A-Za-z0-9]{2,5})(?:\|[^!\n]*)?!/gu, (_m, name: string) =>
    hold(`[attachment: ${name.replace(/[[\]]/gu, '')}]`),
  );
  // [text|url]
  out = out.replace(/\[([^\]|\n]*)\|([^\]\n]+)\]/gu, (_m, label: string, url: string) => {
    const href = safeHref(url.trim());
    const text = label.trim() === '' ? url.trim() : label.trim();
    return href === null ? text : hold(`[${text}](${href})`);
  });
  // [url] and [~user]
  out = out.replace(/\[([^\]|\n]+)\]/gu, (match, inner: string) => {
    const value = inner.trim();
    if (value.startsWith('~')) return `@${value.slice(1)}`;
    const href = safeHref(value);
    if (href !== null && /^(https?:|mailto:)/iu.test(value)) return hold(`[${value}](${href})`);
    return match;
  });
  // *bold* → **bold**, -strike- → ~~strike~~, +under+ → __under__; _em_ is the same in Markdown.
  out = out.replace(
    /(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=$|[^\w*])/gu,
    (_m, lead: string, body: string) => `${lead}**${body}**`,
  );
  out = out.replace(
    /(^|[\s(])-(?=[^\s-])([^\n]*?[^\s-])-(?=$|[\s).,:;!?])/gu,
    (_m, lead: string, body: string) => `${lead}~~${body}~~`,
  );
  out = out.replace(
    /(^|[\s(])\+(?=[^\s+])([^\n+]*?[^\s+])\+(?=$|[\s).,:;!?])/gu,
    (_m, lead: string, body: string) => `${lead}__${body}__`,
  );
  return out;
}
