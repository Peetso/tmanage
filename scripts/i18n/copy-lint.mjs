#!/usr/bin/env node
/**
 * Copy lint (55-13): checks the web message catalogs against the copy rules and the glossary.
 *
 * Reads (never writes) apps/web/src/lib/i18n/messages/{en,ar}.json and the glossary at
 * packages/domain/src/i18n/glossary.json. Rules are in docs/product/copy-rules.md.
 *
 * Errors (fail the run unless listed in copy-lint-baseline.json):
 *   missing-key        a key exists in one catalog only
 *   placeholder        AR uses a {placeholder} that EN does not fill, so it would show raw
 *   forbidden-term     an internal word (tenant, projection, ...) in user-facing copy
 *   internal-leak      an internal identifier or a stack trace in user-facing copy
 *   untranslated-ar    the AR value equals EN, or has no Arabic letters, while EN has words
 * Warnings (reported, never fail the run):
 *   placeholder-dropped AR leaves out an EN {placeholder} (often fine: Arabic singular/dual forms)
 *   glossary           EN uses a glossary term, AR uses none of its accepted forms
 *   jargon             a technical word that has a plain alternative
 *   sentence-length    more than 14 words in a UI sentence, 20 in help text
 *   exclamation        a value ends with "!"
 *
 * Usage: node scripts/i18n/copy-lint.mjs [--warnings] [--json] [--update-baseline]
 * Exit 1 when an error is not in the baseline, 0 otherwise.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MESSAGES = join(ROOT, 'apps/web/src/lib/i18n/messages');
const GLOSSARY = join(ROOT, 'packages/domain/src/i18n/glossary.json');
const BASELINE = join(dirname(fileURLToPath(import.meta.url)), 'copy-lint-baseline.json');

export const ERROR_RULES = new Set([
  'missing-key',
  'placeholder',
  'forbidden-term',
  'internal-leak',
  'untranslated-ar',
]);

const UI_WORD_LIMIT = 14;
const HELP_WORD_LIMIT = 20;
const HELP_KEY =
  /(description|help|hint|body|intro|explain|subtitle|lead|lede|summary|detail|tooltip|note|paragraph|caption|empty)/i;
const PLACEHOLDER = /\{[^{}]*\}/g;
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;
const ADDRESS = /^(\S+@\S+\.\S+|https?:\/\/\S+)$/;
const LEAK = [
  /\b[a-z]+_id\b/,
  /\bSQLSTATE\b/,
  /\bER_[A-Z_]{3,}\b/,
  /\bat [\w.$<>]+ \([^)]*:\d+:\d+\)/,
  /\bTraceback\b/,
  /\bstack trace\b/i,
  /\bundefined\b|\bNaN\b|\[object Object\]/,
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term) => new RegExp(`(?<![A-Za-z])${escapeRe(term)}(?:s|es)?(?![A-Za-z])`, 'i');

/** Arabic folded for matching: no diacritics or tatweel, one alef, ta marbuta as ha, ya for alef maqsura. */
export function foldArabic(s) {
  return s
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[آأإٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

const placeholders = (s) => [...s.matchAll(PLACEHOLDER)].map((m) => m[0].split(',')[0]).sort();

function stripBrands(s, brands) {
  let out = s.replace(PLACEHOLDER, ' ');
  for (const b of brands)
    out = out.replace(new RegExp(`(?<![\\w])${escapeRe(b)}(?![\\w])`, 'g'), ' ');
  return out;
}

const sentences = (s) =>
  s
    .replace(PLACEHOLDER, 'x')
    .split(/[.!?؟،;:\n]+|\s[—–-]\s/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Lints two flat catalogs. Returns { errors, warnings, baselined, stale } where each finding is
 * { rule, key, detail }. `baseline` is a list of "rule|key" fingerprints accepted as known debt.
 */
export function lintCatalogs({ en, ar, glossary, baseline = [] }) {
  const findings = [];
  const add = (rule, key, detail) => findings.push({ rule, key, detail });
  const brands = [...glossary.brands].sort((a, b) => b.length - a.length);
  const forbidden = glossary.forbidden.map((f) => ({ ...f, re: wordRe(f.en) }));
  const jargon = glossary.jargon.map((j) => ({ ...j, re: wordRe(j.en) }));
  const terms = glossary.terms
    .filter((t) => t.lint)
    .map((t) => ({ ...t, re: wordRe(t.en), stems: t.accept.map(foldArabic) }))
    .sort((a, b) => b.en.length - a.en.length);

  for (const key of Object.keys(ar)) if (!(key in en)) add('missing-key', key, 'only in ar.json');

  for (const [key, enValue] of Object.entries(en)) {
    const arValue = ar[key];
    if (typeof arValue !== 'string') {
      add('missing-key', key, 'missing from ar.json');
      continue;
    }
    const enSlots = new Set(placeholders(enValue));
    const arSlots = new Set(placeholders(arValue));
    for (const slot of arSlots) if (!enSlots.has(slot)) add('placeholder', key, `ar adds ${slot}`);
    for (const slot of enSlots)
      if (!arSlots.has(slot)) add('placeholder-dropped', key, `ar drops ${slot}`);

    const enText = enValue.replace(PLACEHOLDER, ' ');
    for (const f of forbidden)
      if (f.re.test(enText)) add('forbidden-term', key, `"${f.en}" -> "${f.use}"`);
    for (const re of [...LEAK]) {
      const hit = enText.match(re) ?? arValue.replace(PLACEHOLDER, ' ').match(re);
      if (hit) add('internal-leak', key, hit[0]);
    }

    const enWords = stripBrands(enValue, brands);
    const arWords = stripBrands(arValue, brands);
    const translatable =
      (enWords.match(/[A-Za-z]/g) ?? []).length > 2 && !ADDRESS.test(enValue.trim());
    if (translatable && !ARABIC.test(arWords) && LATIN.test(arWords))
      add('untranslated-ar', key, arValue === enValue ? 'same as English' : 'no Arabic letters');

    for (const j of jargon) if (j.re.test(enText)) add('jargon', key, `"${j.en}" -> "${j.use}"`);

    const arFolded = foldArabic(arValue);
    let rest = enText;
    for (const t of terms) {
      if (!t.re.test(rest)) continue;
      rest = rest.replace(new RegExp(t.re.source, 'gi'), ' ');
      if (ARABIC.test(arValue) && !t.stems.some((s) => arFolded.includes(s)))
        add('glossary', key, `"${t.en}" should read "${t.ar}"`);
    }

    const limit = HELP_KEY.test(key.split('.').pop() ?? key) ? HELP_WORD_LIMIT : UI_WORD_LIMIT;
    for (const [lang, value] of [
      ['en', enValue],
      ['ar', arValue],
    ]) {
      const longest = Math.max(0, ...sentences(value).map((s) => s.split(/\s+/).length));
      if (longest > limit) add('sentence-length', key, `${lang} ${longest} words (limit ${limit})`);
      if (/!\s*$/.test(value)) add('exclamation', key, `${lang} ends with "!"`);
    }
  }

  const accepted = new Set(baseline);
  const seen = new Set();
  const errors = [];
  const baselined = [];
  const warnings = [];
  for (const f of findings) {
    if (!ERROR_RULES.has(f.rule)) {
      warnings.push(f);
      continue;
    }
    const fp = `${f.rule}|${f.key}`;
    seen.add(fp);
    (accepted.has(fp) ? baselined : errors).push(f);
  }
  const stale = [...accepted].filter((fp) => !seen.has(fp));
  return { errors, warnings, baselined, stale };
}

function countBy(list) {
  const out = {};
  for (const f of list) out[f.rule] = (out[f.rule] ?? 0) + 1;
  return out;
}

function main(argv) {
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const en = readJson(join(MESSAGES, 'en.json'));
  const ar = readJson(join(MESSAGES, 'ar.json'));
  const glossary = readJson(GLOSSARY);
  const baseline = argv.includes('--update-baseline') ? [] : readJson(BASELINE).accepted;
  const result = lintCatalogs({ en, ar, glossary, baseline });

  if (argv.includes('--update-baseline')) {
    const accepted = [...new Set(result.errors.map((f) => `${f.rule}|${f.key}`))].sort();
    const body = {
      $comment:
        'Known copy-lint errors accepted so CI starts green (55-13). Fix the copy, then delete the line. Regenerate only with --update-baseline after review.',
      accepted,
    };
    writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
    console.warn(`copy-lint: baseline written with ${accepted.length} entries`);
    return 0;
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const show = (label, list) => {
      for (const f of list) console.warn(`${label} ${f.rule} ${f.key}: ${f.detail}`);
    };
    show('error', result.errors);
    if (argv.includes('--warnings')) show('warning', result.warnings);
    for (const fp of result.stale)
      console.warn(`stale baseline entry (now fixed, delete it): ${fp}`);
    console.warn(
      `copy-lint: ${result.errors.length} new errors, ${result.baselined.length} baselined, ` +
        `${result.warnings.length} warnings ${JSON.stringify(countBy(result.warnings))}`,
    );
  }
  return result.errors.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
