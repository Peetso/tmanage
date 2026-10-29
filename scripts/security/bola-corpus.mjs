#!/usr/bin/env node
/**
 * 56-04 / SEC-01 — the BOLA corpus generator.
 *
 * Writes `apps/api/test/fixtures/bola-corpus.json`: every live HTTP route the isolation suite
 * (`apps/api/test/sec-001-bola-corpus.db.test.ts`) drives, generated from the controllers rather
 * than written by hand, so a new route joins the corpus by re-running this script. The suite
 * holds the file to Nest's own route reflection and fails when it is stale.
 *
 * ## Where the route list comes from
 *
 * The brief offered two sources: the API's route enumeration or the OpenAPI document served at
 * `GET /openapi/ai.json`. The OpenAPI document is generated from the AI-action registry and lists
 * only AI-callable safe and confirm operations — NEVER routes (sessions, tokens, platform admin,
 * security settings) are absent by design — so it cannot be the source of an isolation corpus,
 * which must cover exactly the routes the AI may not call too. This script therefore reads the
 * route decorators of every `apps/api/src/**\/*.controller.ts` (the same set the 56-15 census
 * reflects over), without running the API: `@Controller(base)` × `@Get|@Post|@Put|@Patch|@Delete
 * (sub)`, joined the way Nest joins them. No database, no network, no clock: the same tree gives
 * byte-identical output.
 *
 * Per route it records the class (`org`, `platform`, `session-only`), every `:param`, the table
 * each param most plausibly names (`projectId` → `projects`), and the body fields that carry an
 * object id (`…Id` / `…Ids` members of the handler's `@Body()` interface, or `@Body('xId')`).
 * The suite substitutes the other tenant's object id into every one of them.
 *
 * ## What was stale: the upload enum (53 §53-20 (1), SEC56-19)
 *
 * `docs/planning/contracts/openapi.yaml` `CreateUploadSessionRequest.purpose` listed four values
 * — `message_attachment, request_attachment, deliverable, document` — while the product accepts
 * six: `UPLOAD_PURPOSES` in `schema.ts` (and the ENUM on both file tables) gained `org_logo`
 * (0224, A11) and `request_message` (0232, A8) without the contract moving. The contract is fixed
 * in the same change, and this script now refuses to write a corpus while the two disagree, so
 * the drift cannot come back silently.
 *
 * Usage: `node scripts/security/bola-corpus.mjs` (writes the file) or `--check` (exit 1 when the
 * file on disk differs from what would be written).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SRC = join(ROOT, 'apps/api/src');
const OUT = join(ROOT, 'apps/api/test/fixtures/bola-corpus.json');

const ORG_PREFIX = /^[A-Z]+ \/v1\/organizations\/:orgSlug(?:\/|$)/;
const PLATFORM_PREFIX = /^[A-Z]+ \/v1\/platform(?:\/|$)/;

/**
 * Param names whose table the snake-case rule cannot guess. Kept small and reviewed: a name
 * missing here and in `TABLES` is recorded with `table: null`, and the suite still sends the
 * other tenant's random id for it.
 */
export const PARAM_TABLE_ALIASES = Object.freeze({
  fileId: 'file_assets',
  fileAssetId: 'file_assets',
  attachmentId: 'file_assets',
  uploadSessionId: 'upload_sessions',
  memberId: 'memberships',
  membershipId: 'memberships',
  clientId: 'client_organizations',
  clientOrganizationId: 'client_organizations',
  requestId: 'client_requests',
  clientRequestId: 'client_requests',
  docId: 'documents',
  documentId: 'documents',
  meetingId: 'meetings',
  channelId: 'conversations',
  conversationId: 'conversations',
  messageId: 'messages',
  deliverableId: 'deliverables',
  approvalId: 'approval_requests',
  workflowId: 'automation_workflows',
  tokenId: 'personal_access_tokens',
  grantId: 'oauth_grants',
  invitationId: 'invitations',
  userId: 'users',
  factorId: 'user_mfa_factors',
  sessionId: 'sessions',
});

/**
 * Routes the suite does not drive, each with its reason. Everything else in the corpus is
 * driven. A route with no object id anywhere (no `:param`, no body id field) is added
 * automatically — there is nothing of the other tenant's to substitute — and is covered instead
 * by the leak scan on reads; only routes that *do* carry an id need a line here.
 */
export const NOT_DRIVEN = Object.freeze({});

/** Strip comments, keeping strings intact, so decorators named in prose are not read. */
export function stripComments(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < code.length && code[i] !== q) {
        if (code[i] === '\\') out += code[i++];
        out += code[i++];
      }
      out += code[i++] ?? '';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** `string` constants declared in a file, for `@Controller(CONTENT_BASE)`-style bases. */
function stringConstants(code, files) {
  const map = new Map();
  for (const text of [code, ...files]) {
    for (const m of text.matchAll(/(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']*)'/g))
      if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

function decoratorArg(raw, constants) {
  const arg = raw.trim();
  if (arg === '') return '/';
  const literal = /^'([^']*)'$/.exec(arg);
  if (literal) return literal[1] === '' ? '/' : literal[1];
  if (constants.has(arg)) return constants.get(arg) || '/';
  throw new Error(`unsupported decorator argument: ${arg}`);
}

/** Nest's join, as the 56-15 census reproduces it. */
export function joinPath(base, sub) {
  return `/${[base, sub].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
}

const toSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const singular = (s) => s.replace(/ies$/, 'y').replace(/(?<!s)s$/, '');

/**
 * The table a param most plausibly names, or `null`. Tried in order: the reviewed alias, the
 * param's own snake-case plural (`workItemId` → `work_items`), then the path segment it follows
 * (`…/milestones/:milestoneId` → `project_milestones` when that is the one table ending in
 * `_milestones`, or `…/files/:fileId/comments/:id` → `file_comments`).
 */
export function tableForParam(param, tables, path = '') {
  if (Object.hasOwn(PARAM_TABLE_ALIASES, param) && PARAM_TABLE_ALIASES[param] !== null)
    return PARAM_TABLE_ALIASES[param];
  const base = toSnake(param).replace(/_ids?$/, '');
  const own = [`${base}s`, `${base}es`, base.replace(/y$/, 'ies'), base];
  if (param !== 'id') for (const c of own) if (tables.has(c)) return c;
  const segments = path.split('/');
  const at = segments.indexOf(`:${param}`);
  if (at > 0) {
    const seg = segments[at - 1].replace(/-/g, '_');
    const parent = at > 2 ? singular(segments[at - 3].replace(/-/g, '_')) : '';
    for (const c of [`${parent}_${seg}`, seg]) if (tables.has(c)) return c;
    const suffixed = [...tables].filter((t) => t.endsWith(`_${seg}`));
    if (suffixed.length === 1) return suffixed[0];
  }
  if (param !== 'id') {
    const last = `${base.split('_').at(-1)}s`;
    if (tables.has(last)) return last;
    const suffixed = [...tables].filter((t) => t.endsWith(`_${base}s`));
    if (suffixed.length === 1) return suffixed[0];
  }
  return null;
}

/** Body field names carrying an object id: members of the `@Body()` type, or `@Body('xId')`. */
function bodyIdFields(segment, interfaces) {
  const fields = new Set();
  for (const m of segment.matchAll(/@Body\(\s*'([A-Za-z0-9]+)'\s*\)/g)) fields.add(m[1]);
  for (const m of segment.matchAll(/@Body\(\s*\)\s*[A-Za-z0-9_]+\??\s*:\s*([A-Za-z0-9_]+)/g)) {
    for (const f of interfaces.get(m[1]) ?? []) fields.add(f);
  }
  return [...fields].filter((f) => /[a-z0-9]Ids?$/.test(f)).sort();
}

/** `interface X { readonly aId?: unknown; … }` → field names, per interface / type literal. */
function bodyInterfaces(code) {
  const map = new Map();
  const re =
    /(?:interface\s+([A-Za-z0-9_]+)(?:\s+extends\s+[^{]+)?|type\s+([A-Za-z0-9_]+)\s*=)\s*\{/g;
  for (const m of code.matchAll(re)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    const body = code.slice(start, i - 1);
    const names = [...body.matchAll(/(?:^|[;,\n])\s*(?:readonly\s+)?([A-Za-z0-9_]+)\??\s*:/g)].map(
      (x) => x[1],
    );
    map.set(m[1] ?? m[2], names);
  }
  return map;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.controller.ts')) out.push(path);
  }
  return out;
}

const ROUTE_DECORATOR = /@(Controller|Get|Post|Put|Patch|Delete)\(([^)]*)\)/g;

/** Every route the controllers declare, in file then source order. */
export function scanControllers(srcDir = SRC) {
  const routes = [];
  for (const file of walk(srcDir)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const neighbours = readdirSync(resolve(file, '..'))
      .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))
      .map((n) => readFileSync(resolve(file, '..', n), 'utf8'));
    const constants = stringConstants(code, neighbours);
    const interfaces = bodyInterfaces(code);
    const marks = [...code.matchAll(ROUTE_DECORATOR)];
    let base = null;
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m[1] === 'Controller') {
        base = decoratorArg(m[2], constants);
        continue;
      }
      if (base === null) continue;
      const end = marks[k + 1]?.index ?? code.length;
      const segment = code.slice(m.index, end);
      const handler = /\n\s*(?:public\s+)?(?:async\s+)?([a-zA-Z0-9_]+)\s*\(/.exec(
        segment.replace(/@[A-Za-z]+\([^)]*\)/g, ''),
      )?.[1];
      const path = joinPath(base, decoratorArg(m[2], constants));
      routes.push({
        key: `${m[1].toUpperCase()} ${path}`,
        file: relative(ROOT, file).replace(/\\/g, '/'),
        handler: handler ?? '?',
        bodyIdFields: bodyIdFields(segment, interfaces),
      });
    }
  }
  return routes;
}

/** Keys of an exported object literal in a TS file (`export const NAME … = { 'k': … }`). */
export function registryKeys(code, name) {
  const at = code.indexOf(`export const ${name}`);
  if (at < 0) throw new Error(`${name} not found`);
  const open = code.indexOf('{', code.indexOf('=', at));
  let depth = 0;
  let i = open;
  for (; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) break;
  }
  return [...code.slice(open, i).matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]);
}

/** Every table `schema.ts` declares (`mysqlTable('name', …)`). */
export function schemaTables(schema) {
  return new Set([...schema.matchAll(/mysqlTable\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
}

/** `[]` when the contract's upload purpose enum matches `UPLOAD_PURPOSES`, else the drift. */
export function uploadEnumDrift(schema, contract) {
  const live = [
    ...(/export const UPLOAD_PURPOSES = \[([\s\S]*?)\]/.exec(schema)?.[1] ?? '').matchAll(
      /'([a-z_]+)'/g,
    ),
  ].map((m) => m[1]);
  const at = contract.indexOf('CreateUploadSessionRequest:');
  const doc = /purpose:\s*\{[^}]*enum:\s*\[([^\]]*)\]/.exec(contract.slice(at))?.[1] ?? '';
  const listed = doc
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const missing = live.filter((p) => !listed.includes(p)).map((p) => `contract lacks ${p}`);
  const extra = listed.filter((p) => !live.includes(p)).map((p) => `contract has unknown ${p}`);
  return [...missing, ...extra];
}

export function buildCorpus(root = ROOT) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const schema = read('apps/api/src/common/database/schema.ts');
  const census = read('apps/api/src/security/route-census.ts');
  const drift = uploadEnumDrift(schema, read('docs/planning/contracts/openapi.yaml'));
  if (drift.length > 0) throw new Error(`stale upload enum: ${drift.join('; ')}`);
  const tables = schemaTables(schema);
  const sessionOnly = new Set(registryKeys(census, 'SESSION_ONLY_ROUTES'));
  const routes = [];
  for (const r of scanControllers(join(root, 'apps/api/src'))) {
    const cls = ORG_PREFIX.test(r.key)
      ? 'org'
      : PLATFORM_PREFIX.test(r.key)
        ? 'platform'
        : sessionOnly.has(r.key)
          ? 'session-only'
          : null;
    if (cls === null) continue;
    const params = [...r.key.matchAll(/:([A-Za-z0-9_]+)/g)]
      .map((m) => m[1])
      .filter((p) => !(cls === 'org' && p === 'orgSlug'))
      .map((name) => ({ name, table: tableForParam(name, tables, r.key.split(' ')[1]) }));
    const bodyIds = r.bodyIdFields.filter((f) => !params.some((p) => p.name === f));
    const reason =
      NOT_DRIVEN[r.key] ??
      (params.length === 0 && bodyIds.length === 0 ? 'no object id in path or body' : null);
    routes.push({
      key: r.key,
      class: cls,
      handler: `${r.file}#${r.handler}`,
      params,
      bodyIdFields: bodyIds.map((name) => ({ name, table: tableForParam(name, tables) })),
      ...(reason === null ? {} : { notDriven: reason }),
    });
  }
  routes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set();
  for (const r of routes) {
    if (seen.has(r.key)) throw new Error(`duplicate route ${r.key}`);
    seen.add(r.key);
  }
  const fixtureTables = [
    ...new Set(
      routes.flatMap((r) => [...r.params, ...r.bodyIdFields].map((p) => p.table).filter(Boolean)),
    ),
  ].sort();
  return {
    $comment:
      'Generated by scripts/security/bola-corpus.mjs (56-04 / SEC-01). Do not edit; re-run the script.',
    counts: {
      routes: routes.length,
      org: routes.filter((r) => r.class === 'org').length,
      platform: routes.filter((r) => r.class === 'platform').length,
      sessionOnly: routes.filter((r) => r.class === 'session-only').length,
      driven: routes.filter((r) => r.notDriven === undefined).length,
    },
    fixtureTables,
    routes,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const text = `${JSON.stringify(buildCorpus(), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf8');
    } catch {
      /* missing counts as stale */
    }
    if (current !== text) {
      console.error('bola-corpus.json is stale: run node scripts/security/bola-corpus.mjs');
      process.exit(1);
    }
    console.log('bola-corpus.json is current');
  } else {
    writeFileSync(OUT, text);
    const { counts } = JSON.parse(text);
    console.log(`bola-corpus.json: ${counts.routes} routes (${counts.driven} driven)`);
  }
}
