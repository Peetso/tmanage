#!/usr/bin/env node
// Fitness check for the part docs that exist: PD-1…PD-8 of docs/architecture/PART-DOCS.md §6
// (rows PD-1…PD-8 of FITNESS-FUNCTIONS.md §PD). A part without a PART.md is not an error
// (Peter, 2026-11-20: general standards, not a doc for every part); there is no missing-docs
// ratchet.
//
//   node scripts/arch/part-docs-check.mjs                    check (exit 1 on any violation)
//   node scripts/arch/part-docs-check.mjs --write-registry   regenerate docs/architecture/parts.json
//   node scripts/arch/part-docs-check.mjs --pre-commit       PD-6 warnings for the staged files
//
// Read-only towards git (`rev-list`, `merge-base --is-ancestor`, `diff --cached`).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  KINDS,
  OPTIONAL_HEADINGS,
  REGISTRY_PATH,
  REPO_ROOT,
  REQUIRED_HEADINGS,
  buildRegistry,
  citedRuleIds,
  definedRuleIds,
  findPart,
  ownPathspecs,
  parseContextMap,
  parseFrontMatter,
  sections,
} from './parts-lib.mjs';

/** PD-5 threshold N (proposed in PART-DOCS §6); the warning threshold is N/2. */
export const STALE_COMMITS = 15;
/** PD-7 cap: on-demand CLAUDE.md content is truncated at 40,000 characters (memory docs). */
export const MAX_CHARS = 30_000;
/**
 * Context for parts that are not API modules (packages, apps, ops, web). VIEWS §4 names only
 * module contexts; `cross-cutting` is the proposed value for the rest until VIEWS lists them.
 */
export const EXTRA_CONTEXTS = ['cross-cutting'];
const LIFECYCLES = ['experimental', 'production', 'deprecated'];
const REQUIRED_FIELDS = [
  'part',
  'kind',
  'context',
  'owner',
  'lifecycle',
  'depends_on',
  'provides_api',
  'consumes_api',
  'tables_owned',
  'rules',
  'last_verified_commit',
  'last_verified_date',
  'last_verified_by',
];
const LIST_FIELDS = [
  'depends_on',
  'provides_api',
  'consumes_api',
  'tables_owned',
  'rules',
  'ux_rules',
];
const STANDARDS = [
  'docs/architecture/ENGINEERING-STANDARD.md',
  'docs/architecture/UI-UX-DESIGN-STANDARD.md',
  'docs/architecture/IMPLEMENTATION-PATTERNS.md',
];

const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8');
const has = (root, rel) => existsSync(path.join(root, rel));

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function defaultGit(root) {
  return {
    isAncestor(sha) {
      try {
        git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']);
        return true;
      } catch {
        return false;
      }
    },
    countSince(sha, specs) {
      return Number(git(root, ['rev-list', '--count', `${sha}..HEAD`, '--', ...specs]).trim());
    },
    staged() {
      return git(root, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Checks. Each returns a list of { rule, part, message } (errors) and pushes warnings.
// ---------------------------------------------------------------------------------------------

/** Registry on disk equals the one the §3.4 rules give for today's directory tree. */
export function checkRegistryFresh(root, built) {
  if (!has(root, REGISTRY_PATH)) {
    return [
      { rule: 'PD-1', part: '-', message: `${REGISTRY_PATH} is missing: run --write-registry` },
    ];
  }
  const onDisk = JSON.parse(read(root, REGISTRY_PATH));
  if (JSON.stringify(onDisk.parts) !== JSON.stringify(built.parts)) {
    return [
      {
        rule: 'PD-1',
        part: '-',
        message: `${REGISTRY_PATH} is out of date with the directory tree: run --write-registry and commit it`,
      },
    ];
  }
  return [];
}

/** PD-1: a part that has a PART.md also has its CLAUDE.md loader(s) importing it. */
export function checkLoaders(root, registry) {
  const errors = [];
  for (const p of registry.parts) {
    if (!has(root, p.doc)) continue; // no PART.md is allowed: the general standards apply
    for (const loader of p.loaders) {
      const text = has(root, loader.file) ? read(root, loader.file) : null;
      const imports = text?.split(/\r?\n/).some((line) => line.trim() === loader.import);
      if (!imports) {
        errors.push({
          rule: 'PD-1',
          part: p.id,
          message: `${loader.file} must exist and contain the line "${loader.import}"`,
        });
      }
    }
  }
  return errors;
}

/** PD-2, PD-3, PD-4, PD-7 on one PART.md text. */
export function checkDoc(p, text, ctx) {
  const errors = [];
  const err = (rule, message) => errors.push({ rule, part: p.id, message });
  if (text.length > MAX_CHARS)
    err('PD-7', `${p.doc} is ${text.length} characters (cap ${MAX_CHARS})`);

  const { data, body, error } = parseFrontMatter(text);
  if (error) {
    err('PD-2', `${p.doc}: ${error}`);
    return errors;
  }
  for (const field of REQUIRED_FIELDS) {
    if (!(field in data)) err('PD-2', `front-matter field "${field}" is missing`);
  }
  for (const field of LIST_FIELDS) {
    if (field in data && !Array.isArray(data[field])) err('PD-2', `"${field}" must be a [list]`);
  }
  if (data.part !== undefined && data.part !== p.id)
    err('PD-2', `part "${data.part}" ≠ registry id "${p.id}"`);
  if (data.kind !== undefined && (!KINDS.includes(data.kind) || data.kind !== p.kind)) {
    err('PD-2', `kind "${data.kind}" must be "${p.kind}"`);
  }
  if (data.lifecycle !== undefined && !LIFECYCLES.includes(data.lifecycle)) {
    err('PD-2', `lifecycle "${data.lifecycle}" is not one of ${LIFECYCLES.join(', ')}`);
  }
  if (data.context !== undefined) {
    const allowed =
      p.kind === 'api-module' ? ctx.contexts : new Set([...ctx.contexts, ...EXTRA_CONTEXTS]);
    if (!allowed.has(data.context)) err('PD-2', `context "${data.context}" is not in VIEWS §4`);
    else if (p.context && data.context !== p.context) {
      err('PD-2', `context "${data.context}" ≠ VIEWS §4 context "${p.context}" of this module`);
    }
  }
  if (
    data.last_verified_commit !== undefined &&
    !/^[0-9a-f]{7,40}$/.test(data.last_verified_commit)
  ) {
    err('PD-2', `last_verified_commit "${data.last_verified_commit}" is not a commit sha`);
  }
  if (
    data.last_verified_date !== undefined &&
    !/^\d{4}-\d{2}-\d{2}$/.test(data.last_verified_date)
  ) {
    err('PD-2', `last_verified_date "${data.last_verified_date}" is not YYYY-MM-DD`);
  }

  // PD-3: required headings in order; each non-empty or "n/a — reason".
  const found = sections(body);
  const titles = found.map((s) => s.title);
  let cursor = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const at = titles.indexOf(heading);
    if (at < 0) err('PD-3', `heading "## ${heading}" is missing`);
    else if (at < cursor) err('PD-3', `heading "## ${heading}" is out of order`);
    else cursor = at;
  }
  for (const s of found) {
    if (!REQUIRED_HEADINGS.includes(s.title) && !OPTIONAL_HEADINGS.includes(s.title)) continue;
    const content = s.content.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!content) err('PD-3', `"## ${s.title}" is empty (write it, or "n/a — reason")`);
    else if (/^n\/a\b/i.test(content) && !/^n\/a\s*[—–-]\s*\S/i.test(content)) {
      err('PD-3', `"## ${s.title}" says n/a without "— reason"`);
    }
  }

  // PD-4: every cited rule ID exists in the three standards.
  const cited = new Set([...(data.rules ?? []), ...(data.ux_rules ?? [])]);
  for (const id of citedRuleIds(body, ctx.prefixes)) cited.add(id);
  for (const id of cited) {
    if (!ctx.ruleIds.has(id))
      err('PD-4', `rule ID ${id} is not defined in ${STANDARDS.join(', ')}`);
  }
  return errors;
}

/** PD-5: staleness of last_verified_commit against the part's own paths. */
export function checkStale(p, data, registry, gitApi, warnings) {
  const sha = data?.last_verified_commit;
  if (!sha || !/^[0-9a-f]{7,40}$/.test(sha)) return [];
  if (!gitApi.isAncestor(sha)) {
    return [
      {
        rule: 'PD-5',
        part: p.id,
        message: `last_verified_commit ${sha} is not an ancestor of HEAD`,
      },
    ];
  }
  const n = gitApi.countSince(sha, ownPathspecs(registry, p));
  if (n > STALE_COMMITS) {
    return [
      {
        rule: 'PD-5',
        part: p.id,
        message: `${n} commits on the part since ${sha} (limit ${STALE_COMMITS}): re-verify ${p.doc}`,
      },
    ];
  }
  if (n > STALE_COMMITS / 2)
    warnings.push(
      `PD-5 ${p.id}: ${n} commits since verification (warning at > ${STALE_COMMITS / 2})`,
    );
  return [];
}

/** PD-8: tables_owned against docs/architecture/table-owners.json (active once AR-7 exists). */
export function checkTables(p, data, tableOwners) {
  if (!tableOwners) return [];
  const errors = [];
  const owned = new Set(data?.tables_owned ?? []);
  for (const [table, owner] of Object.entries(tableOwners)) {
    if (owner === p.id && !owned.has(table)) {
      errors.push({
        rule: 'PD-8',
        part: p.id,
        message: `table-owners.json gives it "${table}"; tables_owned lacks it`,
      });
    }
  }
  for (const table of owned) {
    if (tableOwners[table] !== p.id) {
      errors.push({
        rule: 'PD-8',
        part: p.id,
        message: `tables_owned lists "${table}", which table-owners.json gives to ${tableOwners[table] ?? 'nobody'}`,
      });
    }
  }
  return errors;
}

export function runCheck(root = REPO_ROOT, gitApi = defaultGit(root)) {
  const warnings = [];
  const built = buildRegistry(root);
  const errors = checkRegistryFresh(root, built);
  const registry = built;

  errors.push(...checkLoaders(root, registry));

  const standards = STANDARDS.filter((s) => has(root, s)).map((s) => read(root, s));
  const ruleIds = definedRuleIds(standards);
  const ctx = {
    ...parseContextMap(
      has(root, 'docs/architecture/VIEWS.md') ? read(root, 'docs/architecture/VIEWS.md') : '',
    ),
    ruleIds,
    prefixes: new Set([...ruleIds].map((id) => id.split('-')[0])),
  };
  const ownersPath = 'docs/architecture/table-owners.json';
  const tableOwners = has(root, ownersPath) ? JSON.parse(read(root, ownersPath)) : null;
  if (!tableOwners)
    warnings.push('PD-8 inactive: docs/architecture/table-owners.json (AR-7) does not exist yet');
  warnings.push('PD-8 route census for provides_api: inactive until the census exists');

  let documented = 0;
  for (const p of registry.parts) {
    if (!has(root, p.doc)) continue;
    documented += 1;
    const text = read(root, p.doc);
    errors.push(...checkDoc(p, text, ctx));
    const { data } = parseFrontMatter(text);
    errors.push(...checkStale(p, data, registry, gitApi, warnings));
    errors.push(...checkTables(p, data, tableOwners));
  }
  return { errors, warnings, total: registry.parts.length, documented };
}

/** PD-6 (committer): production part changed without its PART.md while already at N/2. */
export function runPreCommit(root = REPO_ROOT, gitApi = defaultGit(root)) {
  const registry = buildRegistry(root);
  const staged = gitApi.staged();
  const warnings = [];
  const touched = new Map();
  for (const file of staged) {
    const p = findPart(registry, file);
    if (p) touched.set(p.id, p);
  }
  for (const p of touched.values()) {
    if (!has(root, p.doc) || staged.includes(p.doc)) continue;
    const { data } = parseFrontMatter(read(root, p.doc));
    if (data?.lifecycle !== 'production' || !data.last_verified_commit) continue;
    if (!gitApi.isAncestor(data.last_verified_commit)) continue;
    const n = gitApi.countSince(data.last_verified_commit, ownPathspecs(registry, p));
    if (n >= STALE_COMMITS / 2) {
      warnings.push(
        `PD-6 ${p.id}: changed without ${p.doc}, already ${n} commits since verification`,
      );
    }
  }
  return warnings;
}

/** Writes JSON formatted as the repo's Prettier config would (so format:check stays green). */
async function writeJson(root, rel, value) {
  let text = `${JSON.stringify(value, null, 2)}
`;
  try {
    const prettier = await import('prettier');
    const file = path.join(root, rel);
    const options = (await prettier.resolveConfig(file)) ?? {};
    text = await prettier.format(text, { ...options, filepath: file });
  } catch {
    // prettier is a workspace devDependency; without it the plain JSON is still valid.
  }
  writeFileSync(path.join(root, rel), text);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const root = REPO_ROOT;
  if (args.has('--write-registry')) {
    const registry = buildRegistry(root);
    await writeJson(root, REGISTRY_PATH, registry);
    console.log(`wrote ${REGISTRY_PATH}: ${registry.parts.length} parts`);
    return;
  }
  if (args.has('--pre-commit')) {
    for (const w of runPreCommit(root)) console.warn(`warning: ${w}`);
    return;
  }
  const { errors, warnings, total, documented } = runCheck(root);
  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const e of errors) console.error(`${e.rule} ${e.part}: ${e.message}`);
  console.log(
    `part docs: ${documented} PART.md checked; ${total - documented} of ${total} parts have none (allowed, PART-DOCS §7)`,
  );
  if (errors.length) {
    console.error(
      `part-docs-check: ${errors.length} violation(s). See docs/architecture/PART-DOCS.md §6.`,
    );
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
