#!/usr/bin/env node
/**
 * Contracts check — D10.
 *
 * What this replaces. `package.json` carried `contracts:validate` =
 * `pnpm --filter @tmanage/contracts validate` from the initial commit, and `pnpm verify` ran it
 * as its fourth step. `packages/contracts` was never authored — not removed, never written — so
 * the filter matched no project, pnpm printed `No projects matched the filters` and exited 0.
 * The gate has therefore been vacuous for the whole life of the repository.
 *
 * What this checks instead, and why it is two things rather than one:
 *
 *   1. **Coverage.** Every `export interface …View` under `apps/api/src/modules/**\/*.service.ts`
 *      must be either asserted against a web type in `e2e/contracts/api-web-shapes.ts` or listed
 *      in EXEMPT below with a reason. A new API response projection therefore cannot appear
 *      unpaired and unnoticed — which is the failure mode a type-level file alone cannot catch,
 *      because a type that nobody wrote an assertion for compiles perfectly.
 *
 *   2. **Agreement.** `tsc --noEmit -p e2e/tsconfig.json` compiles those assertions. A field
 *      renamed on either side, or retyped from `string` to `number`, fails here.
 *
 * Neither half can succeed silently: (1) fails if the pairing file shrinks, (2) fails if the
 * pairing file stops being true, and both fail loudly if their target is missing.
 *
 * Usage: node scripts/contracts-check.mjs [--json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiModulesDir = join(repoRoot, 'apps/api/src/modules');
const pairingFile = join(repoRoot, 'e2e/contracts/api-web-shapes.ts');
const e2eTsconfig = join(repoRoot, 'e2e/tsconfig.json');
const asJson = process.argv.includes('--json');

/**
 * API views with no counterpart in `apps/web/src/lib/api/**`, each with the reason there is
 * none. An entry here is a claim that the web client does not consume the endpoint at all —
 * not that the shapes were hard to line up. The check fails if an entry names a view that no
 * longer exists, so this list cannot rot into a blanket.
 */
const EXEMPT = new Map([
  [
    'ClientOrganizationView',
    'No web consumer: CLIENT-001s client-organization CRUD has no internal screen; apps/web/src/lib/api/clients.ts deliberately wraps only GET projects/:id/clients.',
  ],
  ['ClientMembershipView', 'No web consumer: same as ClientOrganizationView — no screen.'],
  [
    'ConversationMemberView',
    'No web consumer: membership is never fetched by apps/web; the channel screen reads messages only.',
  ],
  ['UploadSessionView', 'No web consumer: FILE-002 has no web client module at all.'],
  ['FileAssetView', 'No web consumer: FILE-002 has no web client module at all.'],
  [
    'WorkItemDependencyView',
    'No web consumer: the work-graph endpoints (dependencies) have no screen; WEB work-items.ts wraps list/get/create/update/transition only.',
  ],
  ['WorkBlockerView', 'No web consumer: same as WorkItemDependencyView.'],
  ['WorkItemHealthView', 'No web consumer: health is computed but no screen reads it yet.'],
  [
    'NotificationPreferencesView',
    'no web consumer yet (NOTIF-001 API-only; pair when the preferences screen lands)',
  ],
]);

// ── 1. Enumerate the API's response projections ─────────────────────────────

function serviceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.service.ts')) continue;
    out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out.sort();
}

if (!existsSync(apiModulesDir)) {
  console.error(`contracts-check: ${relative(repoRoot, apiModulesDir)} does not exist.`);
  process.exit(1);
}

const VIEW_RE = /^export interface ([A-Za-z0-9_]*View)\b/gm;
/** @type {Map<string, string>} view name → `path:line` */
const apiViews = new Map();
for (const file of serviceFiles(apiModulesDir)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(VIEW_RE)) {
    const line = text.slice(0, m.index).split('\n').length;
    apiViews.set(m[1], `${relative(repoRoot, file).split(sep).join('/')}:${line}`);
  }
}

// ── 2. Read the pairing file's assertions ───────────────────────────────────

if (!existsSync(pairingFile)) {
  console.error(
    `contracts-check: ${relative(repoRoot, pairingFile)} is missing. This is the check; without it nothing compares the API to the web client.`,
  );
  process.exit(1);
}
const pairingText = readFileSync(pairingFile, 'utf8');

// Aliases: `import type { WorkItemView as ApiWorkItemView } from '../../apps/api/…'`.
// Resolved rather than assumed, so a pair cannot be claimed by naming a type the file never
// imported from apps/api.
/** @type {Map<string, string>} local alias → exported name in apps/api */
const aliasToView = new Map();
const IMPORT_RE = /import type \{([^}]*)\} from '([^']*)'/g;
for (const m of pairingText.matchAll(IMPORT_RE)) {
  if (!m[2].includes('apps/api/')) continue;
  for (const clause of m[1].split(',')) {
    const parts = clause.trim().split(/\s+as\s+/);
    if (parts.length === 2) aliasToView.set(parts[1], parts[0]);
    else if (parts[0]) aliasToView.set(parts[0], parts[0]);
  }
}

const ASSERT_RE = /Assert<\s*(Exact|Narrows)\s*<\s*([A-Za-z0-9_]+)\s*,\s*([A-Za-z0-9_]+)\s*>\s*>/g;
/** @type {{ kind: string, api: string, web: string }[]} */
const pairs = [];
for (const m of pairingText.matchAll(ASSERT_RE)) {
  const api = aliasToView.get(m[2]);
  if (api) pairs.push({ kind: m[1], api, web: m[3] });
}
const pairedViews = new Set(pairs.map((p) => p.api));

// ── 3. Coverage ─────────────────────────────────────────────────────────────

const problems = [];

for (const [view, where] of apiViews) {
  if (pairedViews.has(view)) continue;
  if (EXEMPT.has(view)) continue;
  problems.push(
    `${where}: \`${view}\` is an API response projection with no counterpart assertion in e2e/contracts/api-web-shapes.ts and no entry in EXEMPT. Pair it with the apps/web type that declares the same response, or add it to EXEMPT with the reason there is no web consumer.`,
  );
}

for (const [view, reason] of EXEMPT) {
  if (apiViews.has(view)) {
    if (!reason || reason.length < 20)
      problems.push(`EXEMPT["${view}"] has no usable reason. Say why there is no web consumer.`);
    continue;
  }
  problems.push(
    `EXEMPT["${view}"] names a view that no longer exists in apps/api. Delete the entry — a stale exemption is how this list turns back into a blanket.`,
  );
}

for (const pair of pairs) {
  if (!apiViews.has(pair.api))
    problems.push(
      `e2e/contracts/api-web-shapes.ts asserts against \`${pair.api}\`, which is no longer an exported …View under apps/api/src/modules/**/*.service.ts.`,
    );
}

if (pairs.length === 0)
  problems.push(
    'e2e/contracts/api-web-shapes.ts contains no Assert<Exact<…>> / Assert<Narrows<…>> assertions. An empty pairing file is the same vacuous gate this check replaced.',
  );

// ── 4. Agreement — compile the assertions ───────────────────────────────────

let tscOutput = '';
let tscOk = true;
if (!existsSync(e2eTsconfig)) {
  tscOk = false;
  tscOutput = `contracts-check: ${relative(repoRoot, e2eTsconfig)} is missing; the assertions cannot be compiled.`;
} else {
  const tsc = spawnSync(
    process.execPath,
    [join(repoRoot, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', e2eTsconfig],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  tscOutput = `${tsc.stdout ?? ''}${tsc.stderr ?? ''}`.trim();
  tscOk = tsc.status === 0;
}

// ── 5. Report ───────────────────────────────────────────────────────────────

const summary = {
  apiViews: apiViews.size,
  paired: pairedViews.size,
  exact: pairs.filter((p) => p.kind === 'Exact').length,
  narrows: pairs.filter((p) => p.kind === 'Narrows').length,
  exempt: EXEMPT.size,
  coverageProblems: problems,
  assignabilityOk: tscOk,
};

if (asJson) {
  console.log(JSON.stringify({ ...summary, tscOutput }, null, 2));
} else {
  console.log(
    `contracts-check: ${apiViews.size} API response views — ${pairedViews.size} paired (${summary.exact} exact, ${summary.narrows} narrowing), ${EXEMPT.size} exempt with a stated reason.`,
  );
  if (problems.length) {
    console.error('\ncontracts-check FAILED — coverage:\n');
    for (const p of problems) console.error(`  - ${p}`);
  }
  if (!tscOk) {
    console.error(
      '\ncontracts-check FAILED — the API and the web client disagree about a response shape:\n',
    );
    console.error(tscOutput || '(tsc produced no output but exited non-zero)');
    console.error(
      '\nThe pairing lives in e2e/contracts/api-web-shapes.ts. Fix whichever side is wrong;\ndo not widen a type to make this pass.',
    );
  }
  if (!problems.length && tscOk) console.log('contracts-check: OK.');
}

process.exit(problems.length === 0 && tscOk ? 0 : 1);
