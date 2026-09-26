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
 *   1. **Coverage — both directions.** The check is no longer one-directional. It enumerates
 *      response projections on *both* sides and asserts each is paired or explicitly exempt:
 *
 *        (a) API side. Every `export interface …View` under `apps/api/src/modules/**` in a
 *            `*.service.ts`, `*.controller.ts` or `*.repository.ts` file (a view lifted into a
 *            controller or repository counts, not only the service layer) must be asserted
 *            against a web type in `e2e/contracts/api-web-shapes.ts` or listed in EXEMPT.
 *
 *        (b) Web side. Every web *response projection* declared in `apps/web/src/lib/api/**`
 *            must be asserted here (Exact or Narrows) or listed in WEB_EXEMPT with a reason.
 *            This closes the reverse gap: a web shape whose endpoint the API never paired can
 *            no longer hide. A "response projection" is every `export interface`/`export type`
 *            EXCEPT the ones the WEB_EXCLUDE rules below drop — request-side shapes (name ends
 *            `Input|Query|Body|Options`), the `client.ts`/`errors.ts` transport and error
 *            plumbing, and literal `type` aliases (string-literal enums like `InboxMode` and
 *            inline object-literal command unions like `TriageMove`). A `type` alias that is a
 *            union of *named* interfaces (e.g. `SignInResponse`) is kept — it is a real response
 *            shape — and paired or exempted like any other.
 *
 *            `Request` is deliberately NOT a dropped suffix (it was until x79). It is an ordinary
 *            domain noun here — `ClientRequest` and `AcceptedClientRequest` are a client's request
 *            *for work*, response shapes, not HTTP request bodies — so a blanket suffix drop hid
 *            real response projections and, worse, would silently omit any future `*Request`
 *            response with no API pair. Genuine request-side `*Request` shapes are instead named
 *            explicitly in WEB_REQUEST_SHAPES, so excluding one is a reviewed act, not a suffix
 *            accident. (`client.ts`'s `ApiRequest` is already dropped by the file rule above.)
 *
 *      A new response projection on either side therefore cannot appear unpaired and unnoticed —
 *      the failure mode a type-level file alone cannot catch, because a type that nobody wrote
 *      an assertion for compiles perfectly.
 *
 *   2. **Agreement.** `tsc --noEmit -p e2e/tsconfig.json` compiles those assertions. A field
 *      renamed on either side, or retyped from `string` to `number`, fails here.
 *
 * Neither half can succeed silently: (1) fails if the pairing file shrinks on either side, (2)
 * fails if the pairing file stops being true, and both fail loudly if their target is missing.
 *
 * Usage: node scripts/contracts-check.mjs [--json]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiModulesDir = join(repoRoot, 'apps/api/src/modules');
const webApiDir = join(repoRoot, 'apps/web/src/lib/api');
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
    'ProjectHealthView',
    'No web consumer: UNIT-12 project health roll-up is authored ready for the screen; no screen reads it yet (x86 follow-up).',
  ],
  [
    'DeliveryFlowView',
    'No web consumer: INS-01 delivery-flow read is authored ready for the /insights screen; no screen reads it yet (x89 follow-up).',
  ],
  [
    'NotificationPreferencesView',
    'no web consumer yet (NOTIF-001 API-only; pair when the preferences screen lands)',
  ],
  [
    'ApprovalDecisionView',
    'No web consumer: FR-05 x92 authors the decide endpoint API-only; the client deep-link decision screen and its projection are x92-b, and pair then (matching the ProjectHealthView posture).',
  ],
  [
    'ImportValidationView',
    'No web consumer yet: ON-09 import is API-only this slice (validate/dry-run); the ON-09 screen is a follow-up. Pair it when that screen lands.',
  ],
  [
    'MeetingView',
    'No web consumer: CAL-01/MTG-01 (x90) ships the API meeting read/write with no screen this slice; pair when the calendar screen lands (x90 follow-up).',
  ],
  [
    'DocumentView',
    'No web consumer: DOC-01 (x91) ships the API document read/write with no screen this slice; pair when the docs hub screen lands (x91 follow-up).',
  ],
  [
    'ClientProjectionView',
    'No web consumer: FR-05 x97 authors publish + read of the client projection API-only; the client deep-link screen that renders it is x97-b (deferred), and pairs then (matching the ApprovalDecisionView posture).',
  ],
  [
    'ImportCommitView',
    'No web consumer yet: ON-09 import commit half (x100) is API-only; the ON-09 screen is a follow-up. Pair it with the web declaration when that screen lands.',
  ],
  [
    'ImportCommitRowView',
    'No web consumer yet: the per-row receipt nested in ImportCommitView (x100), API-only until the ON-09 screen lands.',
  ],
  [
    'MeetingNoteView',
    'No web consumer: CAL-01/MTG-01 second slice (x105) ships the API meeting notes/decisions capture+read with no screen this slice; pair when the calendar/meeting screen lands (x105-b follow-up).',
  ],
]);

/**
 * Web response projections in `apps/web/src/lib/api/**` with no counterpart assertion yet, each
 * with the reason there is none. Same contract as EXEMPT: an entry is a claim that the shape
 * cannot be paired right now, not that lining it up was fiddly, and the check fails if an entry
 * names a shape that no longer exists — so this list cannot rot into a blanket either.
 *
 * The class-3/class-4 shapes (NEXT-SCOPES §Scope B): their API response is an inline object
 * literal that slice x78 lifts into a named `*View`, at which point each moves from here to a
 * pair; `SignInResponse` is a union alias of two arms that pair individually, not a single
 * projection to `Assert`.
 *
 * The class-1-lift shapes carry a *different* reason: a named API interface for each already
 * exists in a controller but is not `export`ed (`MemberView`, `WorkspaceView`, `EstablishedBody`,
 * `ChallengeResponseBody`), so it cannot be imported and paired until that source `export` lands
 * (NEXT-SCOPES §Scope B "class (1-lift)", x69-report §Deferred). This gate now *sees* them —
 * broadening the API enumeration to controllers means the pair can be added the moment the
 * `export` does — but authoring that source `export` is out of this test-only slice, so they are
 * exempted with a truthful, self-expiring reason rather than left to fail the gate.
 */
const WEB_EXEMPT = new Map([
  // class-4 — union alias of AuthenticatedResponse | MfaRequiredResponse; the arms pair
  // individually (class-1-lift), so the union itself is never a single projection to Assert.
  [
    'SignInResponse',
    'union alias of AuthenticatedResponse | MfaRequiredResponse — not a single response projection; the two arms pair individually.',
  ],
  [
    'InboxItem',
    'union alias of InboxBundle | InboxUsageNotice — not a single response projection; the two arms pair individually.',
  ],
  // class-1-lift (MemberSummary, WorkspaceSummary, AuthenticatedResponse, MfaRequiredResponse)
  // was exempted here while its API interface was unexported. x79 exported each interface
  // (members.controller `MemberView`, workspaces.controller `WorkspaceView`, authentication.controller
  // `EstablishedView`/`ChallengeResponseView`) and paired all four Exact in the pairing file, so the
  // entries were retired — the shapes are now paired, not exempt.
]);

// ── 1. Enumerate the API's response projections ─────────────────────────────

/**
 * API response projections live in the service layer, but x71 lifted several into the controller
 * that serialises them, and repository projections are wire shapes too — so a view under any of
 * these three file kinds counts, not only `*.service.ts`.
 */
function apiSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(service|controller|repository)\.ts$/.test(entry.name)) continue;
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
for (const file of apiSourceFiles(apiModulesDir)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(VIEW_RE)) {
    const line = text.slice(0, m.index).split('\n').length;
    apiViews.set(m[1], `${relative(repoRoot, file).split(sep).join('/')}:${line}`);
  }
}

// ── 1b. Enumerate the web client's response projections ─────────────────────

/**
 * A web `export interface`/`export type` is a *response projection* unless one of these drops it:
 *   - it lives in `client.ts` or `errors.ts` — request/response transport and error plumbing,
 *     not an endpoint's response body;
 *   - its name ends in a request-side suffix (`Input|Query|Body|Options`);
 *   - its name is listed in WEB_REQUEST_SHAPES — a request-side shape whose name ends in `Request`
 *     but which is genuinely a fetch body/params type, named here explicitly rather than dropped
 *     by suffix (see below);
 *   - it is a literal `type` alias — a string-literal enum (`type InboxMode = 'all' | …`) or an
 *     inline object-literal command union (`type TriageMove = { to: 'triage' } | …`). A `type`
 *     alias that unions *named* interfaces (e.g. `SignInResponse`) is a real response shape and
 *     is kept.
 * The rule is deliberately about shape, not a hand-maintained allow-list, so a new web response
 * type is caught by default and a new request type is ignored by default.
 *
 * `Request` is NOT a dropped suffix (it was until x79 — review-x77 Important-2). Two *response*
 * shapes are domain nouns that end in it — `ClientRequest` (portal.ts) and `AcceptedClientRequest`
 * (client-requests.ts), a client's request *for work*, not an HTTP request body — and the old
 * suffix drop hid them from the web enumeration, and would silently hide any future `*Request`
 * response noun with no API pair. Both are enumerated now and paired (their web side appears in
 * the pairing file). A genuine request-side `*Request` type is excluded only by being named in
 * WEB_REQUEST_SHAPES below, which makes each such exclusion a reviewed decision. The set is empty
 * today: the one `*Request` request type, `client.ts`'s `ApiRequest`, is already dropped by the
 * file rule, so nothing else needs naming.
 */
const WEB_EXCLUDE_FILES = new Set(['client.ts', 'errors.ts']);
const WEB_REQUEST_SUFFIX = /(?:Input|Query|Body|Options)$/;
/** Request-side shapes whose name ends in `Request` but are fetch body/params types, not responses. */
const WEB_REQUEST_SHAPES = new Set([]);

function webApiFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    if (WEB_EXCLUDE_FILES.has(entry.name)) continue;
    out.push(join(entry.parentPath ?? entry.path, entry.name));
  }
  return out.sort();
}

/** True for a `type` alias RHS that is a single named type or a union of *named* types only. */
function isNamedTypeUnion(rhs) {
  const members = rhs
    .replace(/^\s*\|/, '')
    .split('|')
    .map((s) => s.trim());
  return members.every((member) => /^[A-Za-z_][A-Za-z0-9_.]*(?:<[^>]*>)?(?:\[\])?$/.test(member));
}

const WEB_INTERFACE_RE = /^export interface ([A-Za-z0-9_]+)\b/gm;
const WEB_TYPE_RE = /^export type ([A-Za-z0-9_]+)\s*=\s*([\s\S]*?);/gm;
/** @type {Map<string, string>} web shape name → `path:line` */
const webShapes = new Map();

if (existsSync(webApiDir)) {
  for (const file of webApiFiles(webApiDir)) {
    const text = readFileSync(file, 'utf8');
    const at = (index) =>
      `${relative(repoRoot, file).split(sep).join('/')}:${text.slice(0, index).split('\n').length}`;
    for (const m of text.matchAll(WEB_INTERFACE_RE)) {
      if (WEB_REQUEST_SUFFIX.test(m[1]) || WEB_REQUEST_SHAPES.has(m[1])) continue;
      webShapes.set(m[1], at(m.index));
    }
    for (const m of text.matchAll(WEB_TYPE_RE)) {
      if (WEB_REQUEST_SUFFIX.test(m[1]) || WEB_REQUEST_SHAPES.has(m[1])) continue;
      if (!isNamedTypeUnion(m[2])) continue; // string-literal enum or object-literal command union
      webShapes.set(m[1], at(m.index));
    }
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
/** @type {Map<string, string>} local alias → exported name in apps/web (the web side of a pair) */
const webAliasToShape = new Map();
const IMPORT_RE = /import type \{([^}]*)\} from '([^']*)'/g;
for (const m of pairingText.matchAll(IMPORT_RE)) {
  const target = m[2].includes('apps/api/')
    ? aliasToView
    : m[2].includes('apps/web/')
      ? webAliasToShape
      : null;
  if (!target) continue;
  for (const clause of m[1].split(',')) {
    const parts = clause.trim().split(/\s+as\s+/);
    if (parts.length === 2) target.set(parts[1], parts[0]);
    else if (parts[0]) target.set(parts[0], parts[0]);
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
/** Web shapes named on the web side of a pair, resolved through the aliases above. */
const pairedWebShapes = new Set(
  pairs.map((p) => webAliasToShape.get(p.web)).filter((name) => name !== undefined),
);

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

// ── 3b. Coverage — the web side ──────────────────────────────────────────────

for (const [shape, where] of webShapes) {
  if (pairedWebShapes.has(shape)) continue;
  if (WEB_EXEMPT.has(shape)) continue;
  problems.push(
    `${where}: \`${shape}\` is a web response shape in apps/web/src/lib/api/** with no counterpart assertion in e2e/contracts/api-web-shapes.ts and no entry in WEB_EXEMPT. Pair it with the apps/api view that produces the same response, or add it to WEB_EXEMPT with the reason it has no pair yet.`,
  );
}

for (const [shape, reason] of WEB_EXEMPT) {
  if (webShapes.has(shape)) {
    if (!reason || reason.length < 20)
      problems.push(`WEB_EXEMPT["${shape}"] has no usable reason. Say why the shape has no pair.`);
    continue;
  }
  problems.push(
    `WEB_EXEMPT["${shape}"] names a shape that is no longer an enumerated web response projection in apps/web/src/lib/api/**. Delete the entry — a stale exemption is how this list turns back into a blanket.`,
  );
}

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

const webPairedCount = [...webShapes.keys()].filter((s) => pairedWebShapes.has(s)).length;
const webExemptCount = [...webShapes.keys()].filter((s) => WEB_EXEMPT.has(s)).length;

const summary = {
  apiViews: apiViews.size,
  paired: pairedViews.size,
  exact: pairs.filter((p) => p.kind === 'Exact').length,
  narrows: pairs.filter((p) => p.kind === 'Narrows').length,
  exempt: EXEMPT.size,
  webShapes: webShapes.size,
  webPaired: webPairedCount,
  webExempt: webExemptCount,
  coverageProblems: problems,
  assignabilityOk: tscOk,
};

if (asJson) {
  console.log(JSON.stringify({ ...summary, tscOutput }, null, 2));
} else {
  console.log(
    `contracts-check: ${apiViews.size} API response views — ${pairedViews.size} paired (${summary.exact} exact, ${summary.narrows} narrowing), ${EXEMPT.size} exempt with a stated reason.`,
  );
  console.log(
    `contracts-check: ${webShapes.size} web response shapes — ${webPairedCount} paired, ${webExemptCount} exempt`,
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
