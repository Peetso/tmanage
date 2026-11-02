#!/usr/bin/env node
/**
 * CSV export lint (52-29, plan 52 §16.3): every CSV the product writes goes through the one
 * escaping rule in `packages/domain/src/export/csv.ts` (formula-injection guard + RFC 4180).
 *
 * A source file is a **CSV producer** when it sets a `text/csv;…` content type, a `filename="….csv"`
 * disposition or a `.download = '….csv'` link. A file is a **CSV writer** when it defines a function
 * named like a CSV escaper (`escapeCsvCell`, `escapeCsv`, `csvCell`, `csvEscape`, `toCsv`).
 *
 * Errors:
 *   hand-joined  a producer joins cells itself with `.join(',')` instead of the domain `toCsv`
 *   no-domain    a producer or writer neither imports `toCsv`/`escapeCsvCell` from `@tmanage/domain`
 *                (or a module that re-exports it) nor imports from a local module that does
 *
 * Usage: node scripts/lint/csv-exports.mjs [files...]   (default: apps/{api,worker,web}/src)
 * Exit 1 on any error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAN_ROOTS = ['apps/api/src', 'apps/worker/src', 'apps/web/src'];
const DOMAIN_CSV = join(ROOT, 'packages/domain/src/export/csv.ts');

/**
 * Producers that only stream bytes another module already wrote through the domain rule. Each
 * entry names that writer, so a reviewer can follow the claim.
 */
const STREAMS_STORED_FILE = new Map([
  [
    'apps/api/src/modules/platform-admin/activity/exports.controller.ts',
    'streams the object written by apps/worker/src/jobs/export-jobs.ts and activity/exports.ts',
  ],
]);

const PRODUCER = /['"`]text\/csv;|filename="[^"]*\.csv"|\.download\s*=\s*['"`][^'"`]*\.csv['"`]/;
const WRITER = /\b(?:function\s+|const\s+)(?:escapeCsvCell|escapeCsv|csvCell|csvEscape|toCsv)\b/;
const HAND_JOIN = /\.join\(\s*(['"]),\1\s*\)/;
const DOMAIN_IMPORT =
  /import\s*\{[^}]*\b(?:toCsv|escapeCsvCell)\b[^}]*\}\s*from\s*['"]@tmanage\/domain['"]/;
const IMPORT_FROM = /(?:import|export)\s[^;]*?from\s*['"](\.[^'"]+)['"]/g;

/** Relative import specifiers resolved to source files (`./x.js` → `./x.ts` / `.tsx`). */
function localImports(file, text) {
  const out = [];
  for (const match of text.matchAll(IMPORT_FROM)) {
    const base = resolve(dirname(file), match[1]).replace(/\.js$/, '');
    for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) {
        out.push(candidate);
        break;
      }
    }
  }
  return out;
}

/** True when the file — or a local module it imports, up to two hops — imports the domain writer. */
function usesDomainWriter(file, text, read, depth = 0, seen = new Set()) {
  if (file === DOMAIN_CSV || DOMAIN_IMPORT.test(text)) return true;
  if (depth >= 2) return false;
  seen.add(file);
  for (const dep of localImports(file, text)) {
    if (seen.has(dep)) continue;
    const depText = read(dep);
    if (depText !== null && usesDomainWriter(dep, depText, read, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * Check one source text. `read(path)` returns another file's text (or null) for the import walk.
 * Returns `{ rule, message }` errors, empty when the file is clean.
 */
export function checkSource(file, text, read = readOrNull) {
  if (file === DOMAIN_CSV) return [];
  if (STREAMS_STORED_FILE.has(relative(ROOT, file).split(sep).join('/'))) return [];
  const producer = PRODUCER.test(text);
  const writer = WRITER.test(text);
  if (!producer && !writer) return [];
  const errors = [];
  if (producer && HAND_JOIN.test(text))
    errors.push({ rule: 'hand-joined', message: "joins CSV cells with .join(','); use toCsv" });
  if (!usesDomainWriter(file, text, read))
    errors.push({
      rule: 'no-domain',
      message: 'writes CSV without @tmanage/domain toCsv/escapeCsvCell',
    });
  return errors;
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function* sourceFiles(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(?:ts|tsx|mjs)$/.test(name) && !/\.(?:test|spec|stories)\.tsx?$/.test(name))
      yield path;
  }
}

function main(argv) {
  const files = argv.length
    ? argv.map((file) => resolve(file))
    : SCAN_ROOTS.flatMap((dir) => [...sourceFiles(join(ROOT, dir))]);
  let failures = 0;
  for (const file of files) {
    const text = readOrNull(file);
    if (text === null) continue;
    for (const error of checkSource(file, text)) {
      failures += 1;
      console.error(`${relative(ROOT, file)}: ${error.rule} — ${error.message}`);
    }
  }
  if (failures > 0) {
    console.error(`csv-exports: ${failures} error(s) in ${files.length} file(s).`);
    process.exitCode = 1;
  } else {
    console.log(`csv-exports: ${files.length} file(s) clean.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
