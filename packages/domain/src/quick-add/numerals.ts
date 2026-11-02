/**
 * 55-25 — digits for the quick-add parser and its chip labels.
 *
 * Arabic-Indic (U+0660–0669) and Extended Arabic-Indic / Persian (U+06F0–06F9) digits map one
 * character to one Latin digit, so a converted string keeps every index of the original — the
 * parser matches on the converted copy and cuts spans out of the text the person typed.
 */

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;

/** Every Arabic-Indic and Persian digit (and the Arabic decimal separator) as Latin. Same length. */
export function toLatinDigits(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else if (code >= PERSIAN_ZERO && code <= PERSIAN_ZERO + 9) {
      out += String(code - PERSIAN_ZERO);
    } else if (char === '٫') {
      out += '.';
    } else {
      out += char;
    }
  }
  return out;
}

/** Latin digits as Arabic-Indic, for an organization whose `digits` setting is `arab`. */
export function toArabicDigits(text: string): string {
  return text.replace(/[0-9]/g, (digit) => String.fromCharCode(ARABIC_INDIC_ZERO + Number(digit)));
}

/** Digits for a chip label: `arab` renders Arabic-Indic, anything else stays Latin. */
export function digitsFor(text: string, digits: 'latn' | 'arab' | string): string {
  return digits === 'arab' ? toArabicDigits(toLatinDigits(text)) : toLatinDigits(text);
}
