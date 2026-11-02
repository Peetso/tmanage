import { MoneyError, currencyDigits } from './money.js';

/**
 * 52-09 — an invoice total in words, English and Arabic (spec 52 §7 AR/RTL):
 * `amountInWords(800_000, 'SAR', 'ar')` → «فقط ثمانية آلاف ريال سعودي لا غير»;
 * `amountInWords(800_050, 'SAR', 'en')` → "Eight thousand Saudi riyals and fifty halalas only".
 *
 * The Arabic follows the invoice convention: masculine counting words, the currency named in the
 * singular after the number, groups joined with «و», framed «فقط … لا غير». Named currencies are
 * SAR, AED, EGP, USD and EUR; any other accepted code is spelled with the code itself.
 */

export type WordsLanguage = 'en' | 'ar';

interface CurrencyNames {
  readonly en: readonly [singular: string, plural: string];
  readonly enMinor: readonly [singular: string, plural: string];
  readonly ar: string;
  readonly arMinor: string;
}

const NAMES: Readonly<Record<string, CurrencyNames>> = {
  SAR: {
    en: ['Saudi riyal', 'Saudi riyals'],
    enMinor: ['halala', 'halalas'],
    ar: 'ريال سعودي',
    arMinor: 'هللة',
  },
  AED: {
    en: ['UAE dirham', 'UAE dirhams'],
    enMinor: ['fils', 'fils'],
    ar: 'درهم إماراتي',
    arMinor: 'فلس',
  },
  EGP: {
    en: ['Egyptian pound', 'Egyptian pounds'],
    enMinor: ['piastre', 'piastres'],
    ar: 'جنيه مصري',
    arMinor: 'قرش',
  },
  USD: {
    en: ['US dollar', 'US dollars'],
    enMinor: ['cent', 'cents'],
    ar: 'دولار أمريكي',
    arMinor: 'سنت',
  },
  EUR: {
    en: ['euro', 'euros'],
    enMinor: ['cent', 'cents'],
    ar: 'يورو',
    arMinor: 'سنت',
  },
};

// ── English ──────────────────────────────────────────────────────────────────

const EN_ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
const EN_SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function enBelowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${EN_ONES[hundreds]!} hundred`);
  if (rest > 0) {
    if (rest < 20) parts.push(EN_ONES[rest]!);
    else {
      const unit = rest % 10;
      parts.push(
        unit === 0
          ? EN_TENS[Math.floor(rest / 10)]!
          : `${EN_TENS[Math.floor(rest / 10)]!}-${EN_ONES[unit]!}`,
      );
    }
  }
  return parts.join(' ');
}

export function englishNumber(value: number): string {
  if (value === 0) return EN_ONES[0]!;
  const groups: string[] = [];
  let rest = value;
  let scale = 0;
  while (rest > 0) {
    const group = rest % 1000;
    if (group > 0) {
      const words = enBelowThousand(group);
      groups.unshift(EN_SCALES[scale] === '' ? words : `${words} ${EN_SCALES[scale]!}`);
    }
    rest = Math.floor(rest / 1000);
    scale += 1;
  }
  return groups.join(' ');
}

// ── Arabic ───────────────────────────────────────────────────────────────────

const AR_ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
const AR_TEENS = [
  'عشرة',
  'أحد عشر',
  'اثنا عشر',
  'ثلاثة عشر',
  'أربعة عشر',
  'خمسة عشر',
  'ستة عشر',
  'سبعة عشر',
  'ثمانية عشر',
  'تسعة عشر',
];
const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const AR_HUNDREDS = [
  '',
  'مائة',
  'مئتان',
  'ثلاثمائة',
  'أربعمائة',
  'خمسمائة',
  'ستمائة',
  'سبعمائة',
  'ثمانمائة',
  'تسعمائة',
];
/** [one, two, 3–10 (plural), 11+ (singular)] per scale. */
const AR_SCALES: readonly (readonly [string, string, string, string])[] = [
  ['', '', '', ''],
  ['ألف', 'ألفان', 'آلاف', 'ألف'],
  ['مليون', 'مليونان', 'ملايين', 'مليون'],
  ['مليار', 'ملياران', 'مليارات', 'مليار'],
  ['تريليون', 'تريليونان', 'تريليونات', 'تريليون'],
];

function arBelowThousand(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(AR_HUNDREDS[hundreds]!);
  if (rest > 0) {
    if (rest < 10) parts.push(AR_ONES[rest]!);
    else if (rest < 20) parts.push(AR_TEENS[rest - 10]!);
    else {
      const unit = rest % 10;
      const tens = AR_TENS[Math.floor(rest / 10)]!;
      parts.push(unit === 0 ? tens : `${AR_ONES[unit]!} و${tens}`);
    }
  }
  return parts.join(' و');
}

function arGroup(group: number, scale: number): string {
  if (scale === 0) return arBelowThousand(group);
  const [one, two, plural, single] = AR_SCALES[scale]!;
  if (group === 1) return one;
  if (group === 2) return two;
  const rest = group % 100;
  return `${arBelowThousand(group)} ${rest >= 3 && rest <= 10 ? plural : single}`;
}

export function arabicNumber(value: number): string {
  if (value === 0) return 'صفر';
  const groups: string[] = [];
  let rest = value;
  let scale = 0;
  while (rest > 0) {
    const group = rest % 1000;
    if (group > 0) groups.unshift(arGroup(group, scale));
    rest = Math.floor(rest / 1000);
    scale += 1;
  }
  return groups.join(' و');
}

// ── The amount ───────────────────────────────────────────────────────────────

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function amountInWords(
  amountMinor: number,
  currency: string,
  language: WordsLanguage,
): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new MoneyError('amountMinor must be a whole number from 0');
  }
  const digits = currencyDigits(currency);
  const factor = 10 ** digits;
  const major = Math.floor(amountMinor / factor);
  const minor = amountMinor % factor;
  const names = NAMES[currency];
  if (language === 'ar') {
    const unit = names?.ar ?? currency;
    const minorUnit = names?.arMinor ?? '';
    const main = `${arabicNumber(major)} ${unit}`;
    const cents = minor > 0 ? ` و${arabicNumber(minor)} ${minorUnit}`.trimEnd() : '';
    return `فقط ${main}${cents} لا غير`;
  }
  const [one, many] = names?.en ?? [currency, currency];
  const [minorOne, minorMany] = names?.enMinor ?? ['', ''];
  const main = `${englishNumber(major)} ${major === 1 ? one : many}`;
  const cents =
    minor > 0 ? ` and ${englishNumber(minor)} ${minor === 1 ? minorOne : minorMany}`.trimEnd() : '';
  return `${capitalise(main)}${cents} only`;
}
