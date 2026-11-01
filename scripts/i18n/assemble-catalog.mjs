#!/usr/bin/env node
// R12 R2 — assemble a language worker's translated chunks into the web catalog.
//
//   node scripts/i18n/assemble-catalog.mjs <lang> <chunk.jsonl> [<chunk.jsonl> ...]
//
// Each JSONL line is `{"key": "...", "value": "..."}` (or `{"<key>": "<value>"}`). The output,
// apps/web/src/lib/i18n/messages/<lang>.json, lists the keys in en.json's order (keys en.json
// lacks are dropped and reported), LF line ends, two-space indent. A key no chunk translated is
// left out, so the parity check reports it and `t()` falls back to English for it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [lang, ...chunks] = process.argv.slice(2);
if (!lang || chunks.length === 0 || !/^[a-z]{2}(-[A-Z]{2})?$/u.test(lang) || lang === 'en') {
  console.error('usage: node scripts/i18n/assemble-catalog.mjs <lang> <chunk.jsonl>...');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const enPath = join(root, 'apps/web/src/lib/i18n/messages/en.json');
const en = JSON.parse(readFileSync(enPath, 'utf8'));
const translated = new Map();
const dropped = [];
for (const chunk of chunks) {
  const lines = readFileSync(chunk, 'utf8').split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      console.error(`${chunk}:${index + 1}: not JSON`);
      process.exit(1);
    }
    const pairs =
      typeof row.key === 'string' && typeof row.value === 'string'
        ? [[row.key, row.value]]
        : Object.entries(row);
    for (const [key, value] of pairs) {
      if (typeof value !== 'string') continue;
      if (Object.prototype.hasOwnProperty.call(en, key)) translated.set(key, value);
      else dropped.push(key);
    }
  });
}
const out = {};
for (const key of Object.keys(en)) if (translated.has(key)) out[key] = translated.get(key);
writeFileSync(
  join(root, `apps/web/src/lib/i18n/messages/${lang}.json`),
  `${JSON.stringify(out, null, 2)}\n`,
);
const missing = Object.keys(en).length - Object.keys(out).length;
console.log(`${lang}.json: ${Object.keys(out).length} keys, ${missing} untranslated`);
if (dropped.length) console.log(`dropped (not in en.json): ${dropped.join(', ')}`);
