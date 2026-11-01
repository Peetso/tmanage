#!/usr/bin/env node
// R12 R2 — check one language catalog against English, by the rules `i18n-key-parity.test.ts`
// enforces, plus the "identical to English" share a language worker uses to see what is left.
//
//   node scripts/i18n/check-catalog.mjs <lang>     (es | fr | pt-BR | de | zh-CN | ar)
//
// Checks the web catalog (apps/web/src/lib/i18n/messages/<lang>.json) and the email catalog
// (apps/api/src/common/i18n/email/<lang>.json). Exit 1 when a rule fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLACEHOLDER = /\{(\w+)\}/gu;

function placeholders(value) {
  return new Set([...String(value).matchAll(PLACEHOLDER)].map((match) => match[1]));
}

/**
 * The rules. `strict` (Arabic and any reviewed catalog): no key missing. Beta: at most
 * `maxMissingShare` of the English keys missing, and every `{placeholder}` of the English line
 * present in the translation (reported, not enforced, for a reviewed catalog: Arabic's singular and
 * dual forms legitimately drop `{count}`). Always: no stray key, every value a non-empty string.
 */
export function checkCatalog(en, catalog, { strict = false, maxMissingShare = 0.01 } = {}) {
  const enKeys = Object.keys(en);
  const missing = enKeys.filter((key) => !Object.prototype.hasOwnProperty.call(catalog, key));
  const stray = Object.keys(catalog).filter(
    (key) => !Object.prototype.hasOwnProperty.call(en, key),
  );
  const empty = Object.entries(catalog)
    .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    .map(([key]) => key);
  const placeholder = [];
  let identical = 0;
  for (const key of enKeys) {
    if (!Object.prototype.hasOwnProperty.call(catalog, key)) continue;
    const value = catalog[key];
    if (value === en[key]) identical += 1;
    for (const name of placeholders(en[key])) {
      if (!placeholders(value).has(name)) placeholder.push(`${key} {${name}}`);
    }
  }
  const missingShare = enKeys.length === 0 ? 0 : missing.length / enKeys.length;
  const ok =
    stray.length === 0 &&
    empty.length === 0 &&
    (strict ? missing.length === 0 : placeholder.length === 0 && missingShare <= maxMissingShare);
  return {
    ok,
    missing,
    stray,
    empty,
    placeholder,
    missingShare,
    identicalShare: enKeys.length === 0 ? 0 : identical / enKeys.length,
  };
}

function report(label, result) {
  const pct = (share) => `${(share * 100).toFixed(1)} %`;
  console.log(`${label}: ${result.ok ? 'OK' : 'FAILED'}`);
  console.log(`  missing ${result.missing.length} (${pct(result.missingShare)})`);
  if (result.missing.length) console.log(`    ${result.missing.slice(0, 50).join('\n    ')}`);
  for (const name of ['stray', 'empty', 'placeholder']) {
    console.log(`  ${name} ${result[name].length}`);
    if (result[name].length) console.log(`    ${result[name].slice(0, 50).join('\n    ')}`);
  }
  console.log(`  identical to English ${pct(result.identicalShare)}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const lang = process.argv[2];
  if (!lang) {
    console.error('usage: node scripts/i18n/check-catalog.mjs <lang>');
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const status = readFileSync(join(root, 'apps/web/src/lib/i18n/catalog-status.ts'), 'utf8');
  const quoted = lang.includes('-') ? `'${lang}'` : lang;
  const strict = lang === 'ar' || new RegExp(`${quoted}: 'reviewed'`).test(status);
  const web = checkCatalog(
    read('apps/web/src/lib/i18n/messages/en.json'),
    read(`apps/web/src/lib/i18n/messages/${lang}.json`),
    { strict },
  );
  const email = checkCatalog(
    read('apps/api/src/common/i18n/email/en.json'),
    read(`apps/api/src/common/i18n/email/${lang}.json`),
    { strict },
  );
  report(`web ${lang}${strict ? ' (strict)' : ' (beta)'}`, web);
  report(`email ${lang}`, email);
  process.exit(web.ok && email.ok ? 0 : 1);
}
