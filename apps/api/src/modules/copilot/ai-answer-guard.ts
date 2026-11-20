/**
 * 62-12 (plan 62 §7, J4) — the last check on an answer before the member sees it. Two rules, both
 * applied by code to the model's text (never asked of the model):
 *
 * 1. **Inert links.** The answer is shown as text. A markdown image is removed (an image URL loads
 *    by itself and can carry data out); a markdown link keeps its words and loses its target unless
 *    the target is a path inside TManage (`/…`, never `//…`); raw HTML tags are dropped; a bare
 *    `http(s)://` address is broken (`hxxps://`) so no renderer turns it into a link. Control
 *    characters (bidi overrides included) are removed.
 * 2. **Number grounding.** A figure in the answer — a number with 3 or more digits, a decimal, a
 *    percentage or an amount — must appear in what the turn's tools returned or in the member's
 *    own message (also as minor units: "49.00" is grounded by 4900). An ungrounded figure is
 *    withheld: replaced by "—" and counted, so the card can say a figure could not be checked.
 *    Small whole numbers (counts, days) pass; sums the model computed are withheld, which errs on
 *    the side of showing nothing rather than an invented figure.
 */

export const WITHHELD_FIGURE = '\u2014';

export interface GuardedAnswer {
  readonly text: string;
  /** Figures removed because no tool result or the message contained them. */
  readonly withheldFigures: number;
  /** Links removed or made inert. */
  readonly inertLinks: number;
}

const IMAGE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const LINK = /\[([^\]]+)\]\(([^)]*)\)/g;
const TAG = /<\/?[A-Za-z][^>]*>/g;
const BARE_URL = /\b(h)(ttps?:\/\/)/gi;
/** C0/C1 controls except tab and newline, and the bidi embeddings, overrides and isolates. */
function isStripped(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function stripControls(text: string): string {
  let out = '';
  for (const char of text) if (!isStripped(char.codePointAt(0)!)) out += char;
  return out;
}

/** A path inside TManage: one leading slash, no scheme, no protocol-relative `//`. */
function internalPath(target: string): boolean {
  const trimmed = target.trim();
  return /^\/(?!\/)[^\s]*$/.test(trimmed) && !trimmed.includes('\\');
}

export function inertLinks(text: string): { text: string; count: number } {
  let count = 0;
  let out = stripControls(text);
  out = out.replace(IMAGE, (_m, alt: string) => {
    count += 1;
    return alt;
  });
  out = out.replace(LINK, (match, words: string, target: string) => {
    if (internalPath(target)) return match;
    count += 1;
    return words;
  });
  out = out.replace(TAG, () => {
    count += 1;
    return '';
  });
  out = out.replace(BARE_URL, (_m, _h: string, rest: string) => {
    count += 1;
    return `hxx${rest.slice(2)}`;
  });
  return { text: out, count };
}

/**
 * A figure: an optional currency sign, digits with optional thousands separators, an optional
 * decimal part, an optional percent sign. Whole numbers under 3 digits without a decimal, a
 * currency or a percent are counts and pass.
 */
const FIGURE =
  /([$\u20AC\u00A3\u00A5\uFDFC]\s?)?(\d{1,3}(?:[,\u00A0\u202F ]\d{3})+|\d+)(\.\d+)?(\s?%)?/g;
const NUMBER = /\d+(?:[.,]\d+)*/g;

function valueOf(digits: string, decimals: string | undefined): number {
  return Number(`${digits.replace(/[^\d]/g, '')}${decimals ?? ''}`);
}

/** Every number the evidence holds, as values (with `1,234.5` and `1234.5` both read). */
export function evidenceNumbers(evidence: readonly string[]): ReadonlySet<number> {
  const values = new Set<number>();
  for (const text of evidence) {
    for (const match of text.matchAll(NUMBER)) {
      const raw = match[0];
      values.add(Number(raw.replace(/,/g, '')));
      for (const part of raw.split(/[.,]/)) values.add(Number(part));
    }
  }
  values.delete(Number.NaN);
  return values;
}

function grounded(value: number, evidence: ReadonlySet<number>): boolean {
  if (evidence.has(value)) return true;
  // An amount in major units the tools returned in minor units (49.00 ↔ 4900), and back.
  return evidence.has(Math.round(value * 100)) || evidence.has(value / 100);
}

export function groundNumbers(
  text: string,
  evidence: ReadonlySet<number>,
): { text: string; count: number } {
  let count = 0;
  const out = text.replace(
    FIGURE,
    (
      match,
      currency: string | undefined,
      digits: string,
      decimals: string | undefined,
      percent: string | undefined,
    ) => {
      const plainDigits = digits.replace(/[^\d]/g, '');
      const isFigure =
        currency !== undefined ||
        decimals !== undefined ||
        percent !== undefined ||
        plainDigits.length >= 3;
      if (!isFigure) return match;
      if (grounded(valueOf(digits, decimals), evidence)) return match;
      count += 1;
      return WITHHELD_FIGURE;
    },
  );
  return { text: out, count };
}

/** Apply both rules to a model answer, against the turn's tool results and the member's message. */
export function guardAnswer(answer: string, evidence: readonly string[]): GuardedAnswer {
  const links = inertLinks(answer);
  const numbers = groundNumbers(links.text, evidenceNumbers(evidence));
  return { text: numbers.text, withheldFigures: numbers.count, inertLinks: links.count };
}
