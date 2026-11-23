#!/usr/bin/env node
/**
 * Design-token size lint (UX-11 sizes, UX-25; ADR-0016).
 *
 * Every size on screen comes from a token: the type scale (`--t-*`, `--t-app-*`), the space
 * scale (`--s1…--s24`), Density v2 (`--app-*`, `--inset-*`, `--page-gutter`, `--target-min`)
 * or a layout token. Fable's measured review of 2026-11-23 found ~3,500 hard-coded sizes
 * against 44 token uses, and that is why the site had 9 page-title sizes and 43 control
 * heights. This lint stops the number from growing and lets it only shrink.
 *
 * Checked declarations (in `apps/web/src/**\/*.css` and `packages/ui/src/styles/*.css`):
 *   font-size · height, min-height, max-height, block-size, min-block-size, max-block-size ·
 *   padding* · margin* · gap, row-gap, column-gap · and any custom property whose value is a
 *   size (so a literal cannot be moved into a local `--x: 13px` to escape the rule).
 * A literal is a number with a `px` or `rem` unit above 2px (a 1–2px hairline or border
 * compensation is not a size decision). The token files themselves are not checked.
 *
 * The ratchet: `docs/architecture/baselines/design-tokens.json` holds each file's count.
 * A file may not exceed its count; a file not in the baseline must have none. A changed file
 * therefore cannot gain a literal. `--update` lowers the baseline to today's counts and refuses
 * to raise any (README §4: raising a baseline needs an ADR).
 *
 * Usage:
 *   node scripts/lint/design-tokens.mjs            check against the baseline (exit 1 on growth)
 *   node scripts/lint/design-tokens.mjs --update   lower the baseline to today's counts
 *   node scripts/lint/design-tokens.mjs --report [--ref <git-ref>] [--json]
 *                                                  totals and distinct values (at a commit)
 *   node scripts/lint/design-tokens.mjs [files...] check only these files
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = join(ROOT, 'docs/architecture/baselines/design-tokens.json');
const SCAN_ROOTS = ['apps/web/src', 'packages/ui/src/styles'];
/** The files that define the tokens; a literal there is the token itself. */
const TOKEN_FILES = new Set([
  'packages/ui/src/styles/tokens.css',
  'packages/ui/src/styles/density.css',
]);

const SIZE_PROPERTY =
  /^(?:font-size|(?:min-|max-)?(?:height|block-size)|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|gap|row-gap|column-gap)$/;
const LITERAL = /(?<![\w-])(\d*\.?\d+)(px|rem)\b/g;

/** Which bucket a property counts in for the report. */
export function categoryOf(property) {
  if (property.startsWith('--')) return 'custom-property';
  if (property === 'font-size') return 'font-size';
  if (/height|block-size/.test(property)) return 'height';
  if (property.startsWith('padding')) return 'padding';
  if (property.startsWith('margin')) return 'margin';
  return 'gap';
}

/** The size literals in one declaration value, in px (rem at 16px). Hairlines are left out. */
export function sizeLiterals(value) {
  const out = [];
  const bare = value.replace(/url\([^)]*\)/g, '');
  for (const match of bare.matchAll(LITERAL)) {
    const px = match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1]);
    if (px > 2) out.push({ text: match[0], px });
  }
  return out;
}

/**
 * Declarations of a stylesheet with their line numbers and selector. Enough of a CSS reader for
 * this job: comments and strings are blanked (keeping line breaks), at-rule preludes are skipped,
 * and a declaration is `name: value` up to `;` or `}` inside a block.
 */
export function declarations(css) {
  const blanked = css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m.replace(/[^\n]/g, ' '));
  const out = [];
  const selectors = [];
  let buffer = '';
  let bufferStart = 0;
  let line = 1;
  for (let i = 0; i < blanked.length; i += 1) {
    const ch = blanked[i];
    if (ch === '{') {
      selectors.push(buffer.trim());
      buffer = '';
      bufferStart = line;
      continue;
    }
    if (ch === ';' || ch === '}') {
      const text = buffer.trim();
      const m = /^(--[\w-]+|[a-z-]+)\s*:\s*([\s\S]+)$/.exec(text);
      const selector = selectors.at(-1) ?? '';
      if (m && selectors.length > 0 && !selector.startsWith('@')) {
        const offset = buffer.length - buffer.trimStart().length;
        const leading = buffer.slice(0, offset).split('\n').length - 1;
        out.push({ property: m[1], value: m[2].trim(), line: bufferStart + leading, selector });
      }
      if (ch === '}') selectors.pop();
      buffer = '';
      bufferStart = line;
      continue;
    }
    if (buffer === '' && ch !== '\n' && /\s/.test(ch) === false) bufferStart = line;
    buffer += ch;
    if (ch === '\n') line += 1;
  }
  return out;
}

/** Every hard-coded size in one stylesheet. */
export function findLiterals(css) {
  const found = [];
  for (const d of declarations(css)) {
    const custom = d.property.startsWith('--');
    if (!custom && !SIZE_PROPERTY.test(d.property)) continue;
    const literals = sizeLiterals(d.value);
    if (literals.length === 0) continue;
    // A custom property counts only when it holds a size, not a shadow or a gradient stop list.
    if (custom && !/^(?:calc\()?[\s\d.+*/()-]*(?:px|rem)[\s\d.+*/()pxrem-]*\)?$/.test(d.value))
      continue;
    found.push({ ...d, category: categoryOf(d.property), literals });
  }
  return found;
}

function walk(dir, out) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.css')) out.push(full);
  }
  return out;
}

const rel = (file) => relative(ROOT, file).split(sep).join('/');

function filesAt(ref) {
  if (!ref) {
    return SCAN_ROOTS.flatMap((root) => walk(join(ROOT, root), []))
      .map(rel)
      .filter((f) => !TOKEN_FILES.has(f))
      .sort();
  }
  const listed = execFileSync('git', ['ls-tree', '-r', '--name-only', ref, ...SCAN_ROOTS], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return listed
    .split('\n')
    .filter((f) => f.endsWith('.css') && !TOKEN_FILES.has(f))
    .sort();
}

function read(file, ref) {
  if (!ref) return readFileSync(join(ROOT, file), 'utf8');
  return execFileSync('git', ['show', `${ref}:${file}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function scan(files, ref) {
  const perFile = new Map();
  for (const file of files) perFile.set(file, findLiterals(read(file, ref)));
  return perFile;
}

function counts(perFile) {
  const out = {};
  for (const [file, found] of perFile) if (found.length > 0) out[file] = found.length;
  return out;
}

export function report(perFile) {
  const byCategory = {};
  const fontSizes = new Map();
  const heights = new Map();
  const titleSizes = new Map();
  let total = 0;
  for (const found of perFile.values()) {
    for (const f of found) {
      total += 1;
      byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
      const first = f.literals[0].px;
      if (f.category === 'font-size') {
        fontSizes.set(first, (fontSizes.get(first) ?? 0) + 1);
        if (/title|(?:^|[\s,>])h1\b/.test(f.selector))
          titleSizes.set(first, (titleSizes.get(first) ?? 0) + 1);
      }
      if (f.category === 'height') heights.set(first, (heights.get(first) ?? 0) + 1);
    }
  }
  const sorted = (m) => [...m.keys()].sort((a, b) => a - b);
  return {
    files: perFile.size,
    filesWithLiterals: Object.keys(counts(perFile)).length,
    total,
    byCategory,
    distinctFontSizes: sorted(fontSizes),
    distinctHeights: sorted(heights),
    distinctTitleSizes: sorted(titleSizes),
  };
}

function readBaseline() {
  return existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).files : {};
}

function writeBaseline(files) {
  const sortedFiles = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
  const total = Object.values(sortedFiles).reduce((a, b) => a + b, 0);
  const body = {
    $comment:
      'Hard-coded sizes per CSS file (scripts/lint/design-tokens.mjs). May only shrink; raising one needs an ADR (docs/architecture/README.md §4, ADR-0016).',
    total,
    files: sortedFiles,
  };
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
}

/** Files over their baseline, with the lines to look at. */
export function violations(perFile, baseline) {
  const out = [];
  for (const [file, found] of perFile) {
    const allowed = baseline[file] ?? 0;
    if (found.length > allowed) out.push({ file, allowed, found });
  }
  return out;
}

function main(argv) {
  const refIndex = argv.indexOf('--ref');
  const ref = refIndex >= 0 ? argv[refIndex + 1] : undefined;
  const explicit = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--ref');
  const files =
    explicit.length > 0
      ? explicit
          .map((f) => rel(resolve(f)))
          .filter((f) => f.endsWith('.css') && !TOKEN_FILES.has(f))
      : filesAt(ref);
  const perFile = scan(files, ref);

  if (argv.includes('--report')) {
    const summary = report(perFile);
    if (argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`design-tokens report${ref ? ` at ${ref}` : ''}`);
      console.log(`  CSS files: ${summary.files}, with literals: ${summary.filesWithLiterals}`);
      console.log(`  hard-coded sizes: ${summary.total}`, summary.byCategory);
      console.log(
        `  distinct font sizes (${summary.distinctFontSizes.length}): ${summary.distinctFontSizes.join(', ')}`,
      );
      console.log(
        `  distinct heights (${summary.distinctHeights.length}): ${summary.distinctHeights.join(', ')}`,
      );
      console.log(
        `  distinct title font sizes (${summary.distinctTitleSizes.length}): ${summary.distinctTitleSizes.join(', ')}`,
      );
    }
    return 0;
  }

  const baseline = readBaseline();
  if (argv.includes('--update')) {
    if (explicit.length > 0) {
      console.error('design-tokens: --update scans every file; do not pass a file list.');
      return 2;
    }
    const hasBaseline = existsSync(BASELINE);
    const grown = hasBaseline ? violations(perFile, baseline) : [];
    if (grown.length > 0) {
      for (const g of grown)
        console.error(`  ${g.file}: ${g.found.length} > baseline ${g.allowed}`);
      console.error(
        'design-tokens: refusing to raise the baseline (needs an ADR). Use tokens instead.',
      );
      return 1;
    }
    writeBaseline(counts(perFile));
    console.log(
      `design-tokens: baseline written, ${report(perFile).total} literals in ${Object.keys(counts(perFile)).length} files.`,
    );
    return 0;
  }

  const bad = violations(perFile, baseline);
  if (bad.length === 0) {
    const total = [...perFile.values()].reduce((n, f) => n + f.length, 0);
    console.log(
      `design-tokens: OK (${perFile.size} files, ${total} literals, none above the baseline).`,
    );
    return 0;
  }
  for (const { file, allowed, found } of bad) {
    console.error(
      `${file}: ${found.length} hard-coded sizes, baseline allows ${allowed}. Use a token:`,
    );
    for (const f of found.slice(0, 40)) {
      console.error(`  ${file}:${f.line}  ${f.property}: ${f.value}`);
    }
  }
  console.error(
    '\nSizes come from tokens (packages/ui/src/styles/tokens.css, density.css). See ADR-0016.',
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)));
}
