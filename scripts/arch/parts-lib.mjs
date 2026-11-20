// Shared core of the part-documentation system (docs/architecture/PART-DOCS.md).
//
// Pure functions only (plus small file readers), so that part-docs-check.mjs (the PD-1…PD-8
// fitness check) and part-docs-gate.mjs (the Claude Code PreToolUse/PostToolUse hook) agree on
// one registry, one path→part mapping and one definition of "the PART.md was read".
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REGISTRY_PATH = 'docs/architecture/parts.json';
export const DOC_NAME = 'PART.md';
export const LOADER_NAME = 'CLAUDE.md';
/**
 * The general standards' entry point (Peter, 2026-11-20: general standards, not a doc for every
 * part). The edit gate asks for it to be read once per session and agent (PART-DOCS.md §3.3).
 */
export const ARCH_README = 'docs/architecture/README.md';

export const KINDS = [
  'api-module',
  'api-common',
  'package',
  'ds-area',
  'app-runtime',
  'web-area',
  'web-shared',
  'ops',
];

/** Build output and tool state: never a part path of its own. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.next',
  '.next-e2e',
  'out',
  'coverage',
  'test-results',
  'storybook-static',
  'playwright-report',
  'release',
]);

/** Web auth group and public token routes (PART-DOCS §3.4: one part each). */
const WEB_AUTH_DIRS = [
  'sign-in',
  'sign-up',
  'setup',
  'recover',
  'sessions',
  'confirm-email',
  'invitations',
  'portal-sign-in',
  'connect',
];
const WEB_PUBLIC_TOKEN_DIRS = ['a', 'f', 'q', 'md'];

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** Forward slashes; Git Bash `/d/x` → `d:/x`. */
export function toPosix(p) {
  let out = String(p).replace(/\\/g, '/');
  const gitBash = /^\/([a-zA-Z])\//.exec(out);
  if (gitBash) out = `${gitBash[1]}:/${out.slice(3)}`;
  return out;
}

/**
 * Repo-relative POSIX path of `file`, or null when it is outside the repository.
 * Windows paths compare case-insensitively (NTFS), so the drive letter case never matters.
 */
export function repoRelative(file, root = REPO_ROOT, cwd = root) {
  if (!file) return null;
  const posix = toPosix(file);
  const absolute = path.posix.isAbsolute(posix) || /^[a-zA-Z]:\//.test(posix);
  const full = toPosix(absolute ? posix : path.resolve(cwd, posix));
  const rootPosix = toPosix(root).replace(/\/+$/, '');
  const insensitive = /^[a-zA-Z]:\//.test(rootPosix);
  const a = insensitive ? full.toLowerCase() : full;
  const b = insensitive ? rootPosix.toLowerCase() : rootPosix;
  if (a !== b && !a.startsWith(`${b}/`)) return null;
  const rel = path.posix.normalize(full.slice(rootPosix.length + 1));
  if (rel.startsWith('..')) return null;
  return rel;
}

function listDirs(root, rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name) && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------------------------
// VIEWS.md §4: module → context
// ---------------------------------------------------------------------------------------------

export function slugContext(name) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Parses the VIEWS §4 context-map table: { contexts: Set<slug>, moduleContext: Map }. */
export function parseContextMap(viewsText) {
  const contexts = new Set();
  const moduleContext = new Map();
  const start = viewsText.indexOf('## 4.');
  if (start < 0) return { contexts, moduleContext };
  const section = viewsText.slice(start).split(/\n## /)[0];
  for (const line of section.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4 || !cells[1] || cells[1] === 'Context' || /^-+$/.test(cells[1])) continue;
    const slug = slugContext(cells[1]);
    contexts.add(slug);
    for (const mod of cells[2].split(',')) {
      const name = mod
        .replace(/\(.*?\)/g, '')
        .replace(/[`*]/g, '')
        .trim();
      if (name) moduleContext.set(name, slug);
    }
  }
  return { contexts, moduleContext };
}

// ---------------------------------------------------------------------------------------------
// Registry (PART-DOCS §3.4 directory rules)
// ---------------------------------------------------------------------------------------------

function part(id, kind, paths, docDir, context = null) {
  const doc = `${docDir}/${DOC_NAME}`;
  // A loader CLAUDE.md sits in every directory path of the part and imports the one PART.md.
  const loaders = paths
    .filter((p) => p.endsWith('/'))
    .map((dir) => {
      const rel = path.posix.relative(dir.replace(/\/$/, ''), docDir) || '.';
      return {
        file: `${dir}${LOADER_NAME}`,
        import: rel === '.' ? `@${DOC_NAME}` : `@${rel}/${DOC_NAME}`,
      };
    });
  return { id, kind, paths, doc, loaders, context };
}

/** Builds the registry from the directory tree. Deterministic: sorted by id. */
export function buildRegistry(root = REPO_ROOT) {
  const viewsPath = path.join(root, 'docs/architecture/VIEWS.md');
  const { moduleContext } = parseContextMap(
    existsSync(viewsPath) ? readFileSync(viewsPath, 'utf8') : '',
  );
  const parts = [];

  for (const m of listDirs(root, 'apps/api/src/modules')) {
    const dir = `apps/api/src/modules/${m}`;
    parts.push(part(`api/${m}`, 'api-module', [`${dir}/`], dir, moduleContext.get(m) ?? null));
  }
  for (const c of listDirs(root, 'apps/api/src/common')) {
    const dir = `apps/api/src/common/${c}`;
    parts.push(part(`api-common/${c}`, 'api-common', [`${dir}/`], dir));
  }
  for (const pkg of listDirs(root, 'packages')) {
    parts.push(part(`package/${pkg}`, 'package', [`packages/${pkg}/`], `packages/${pkg}`));
  }
  if (existsSync(path.join(root, 'packages/ui'))) {
    for (const area of listDirs(root, 'packages/ui/src')) {
      const dir = `packages/ui/src/${area}`;
      parts.push(part(`ds/${area}`, 'ds-area', [`${dir}/`], dir));
    }
    for (const area of ['stories', 'vr']) {
      if (existsSync(path.join(root, 'packages/ui', area))) {
        parts.push(part(`ds/${area}`, 'ds-area', [`packages/ui/${area}/`], `packages/ui/${area}`));
      }
    }
  }
  for (const app of listDirs(root, 'apps')) {
    parts.push(part(`app/${app}`, 'app-runtime', [`apps/${app}/`], `apps/${app}`));
  }

  const appDir = 'apps/web/src/app';
  for (const seg of listDirs(root, `${appDir}/[orgSlug]`)) {
    const dir = `${appDir}/[orgSlug]/${seg}`;
    parts.push(part(`web/org/${seg}`, 'web-area', [`${dir}/`], dir));
  }
  for (const seg of listDirs(root, `${appDir}/platform`)) {
    const dir = `${appDir}/platform/${seg}`;
    parts.push(part(`web/platform/${seg}`, 'web-area', [`${dir}/`], dir));
  }
  if (existsSync(path.join(root, appDir, '(website)'))) {
    const dir = `${appDir}/(website)`;
    parts.push(part('web/website', 'web-area', [`${dir}/`], dir));
  }
  const present = (names) => names.filter((n) => existsSync(path.join(root, appDir, n)));
  const auth = present(WEB_AUTH_DIRS);
  if (auth.length) {
    parts.push(
      part(
        'web/auth',
        'web-area',
        auth.map((n) => `${appDir}/${n}/`),
        `${appDir}/${auth[0]}`,
      ),
    );
  }
  const tokens = present(WEB_PUBLIC_TOKEN_DIRS);
  if (tokens.length) {
    parts.push(
      part(
        'web/public-tokens',
        'web-area',
        tokens.map((n) => `${appDir}/${n}/`),
        `${appDir}/${tokens[0]}`,
      ),
    );
  }
  if (existsSync(path.join(root, appDir, 'i18n'))) {
    const shellPaths = [`${appDir}/i18n/`, `${appDir}/layout.tsx`];
    if (existsSync(path.join(root, 'apps/web/src/lib/i18n')))
      shellPaths.push('apps/web/src/lib/i18n/');
    parts.push(part('web/shell', 'web-area', shellPaths, `${appDir}/i18n`));
  }

  const comp = 'apps/web/src/components';
  if (existsSync(path.join(root, comp, 'session'))) {
    parts.push(
      part(
        'web-shared/session',
        'web-shared',
        [`${comp}/session/`, 'apps/web/src/lib/session-check.ts'],
        `${comp}/session`,
      ),
    );
  }
  if (existsSync(path.join(root, 'apps/web/src/lib/api'))) {
    parts.push(
      part(
        'web-shared/api-client',
        'web-shared',
        ['apps/web/src/lib/api/'],
        'apps/web/src/lib/api',
      ),
    );
  }
  for (const family of listDirs(root, comp)) {
    if (family === 'session') continue;
    parts.push(
      part(`web-shared/${family}`, 'web-shared', [`${comp}/${family}/`], `${comp}/${family}`),
    );
  }

  if (existsSync(path.join(root, 'e2e'))) parts.push(part('ops/e2e', 'ops', ['e2e/'], 'e2e'));
  for (const d of listDirs(root, 'deploy')) {
    parts.push(part(`ops/deploy-${d}`, 'ops', [`deploy/${d}/`], `deploy/${d}`));
  }
  for (const d of listDirs(root, 'scripts')) {
    parts.push(part(`ops/scripts-${d}`, 'ops', [`scripts/${d}/`], `scripts/${d}`));
  }

  parts.sort((a, b) => a.id.localeCompare(b.id));
  return {
    $comment:
      'Generated by `node scripts/arch/part-docs-check.mjs --write-registry` from PART-DOCS.md §3.4. Do not edit by hand.',
    version: 1,
    parts,
  };
}

/** Throws with a precise message when the registry is not usable by the gate. */
export function validateRegistry(registry) {
  if (!registry || !Array.isArray(registry.parts)) throw new Error('registry has no "parts" array');
  for (const [i, p] of registry.parts.entries()) {
    if (!p || typeof p.id !== 'string' || !p.id) throw new Error(`parts[${i}] has no id`);
    if (typeof p.doc !== 'string' || !p.doc.endsWith(DOC_NAME)) {
      throw new Error(`part ${p.id} has no valid "doc"`);
    }
    if (
      !Array.isArray(p.paths) ||
      p.paths.length === 0 ||
      p.paths.some((x) => typeof x !== 'string')
    ) {
      throw new Error(`part ${p.id} has no valid "paths"`);
    }
  }
  return registry;
}

/** Longest-prefix match of a repo-relative path to its part; null when no part owns it. */
export function findPart(registry, rel) {
  if (rel == null) return null;
  const key = rel.toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const p of registry.parts) {
    for (const raw of p.paths ?? []) {
      const prefix = String(raw).toLowerCase();
      const hit = prefix.endsWith('/') ? key.startsWith(prefix) : key === prefix;
      if (hit && prefix.length > bestLen) {
        best = p;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/** Part paths minus the paths of parts nested inside them (for `git rev-list -- <paths>`). */
export function ownPathspecs(registry, target) {
  const specs = [...target.paths];
  for (const other of registry.parts) {
    if (other.id === target.id) continue;
    for (const op of other.paths) {
      if (target.paths.some((tp) => tp.endsWith('/') && op !== tp && op.startsWith(tp))) {
        specs.push(`:(exclude)${op}`);
      }
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------------------------
// PART.md parsing
// ---------------------------------------------------------------------------------------------

export const REQUIRED_HEADINGS = [
  'Purpose and bounded context',
  'Domain model and invariants',
  'Public API and contracts',
  'Data: tables and migrations',
  'Permissions and tenant rules',
  'Runtime, background work and failure modes',
  'UX rules for its screens',
  'Standards that apply',
  'How to change this part',
  'Tests and fitness checks',
  'Open defects, decisions and risks',
];
export const OPTIONAL_HEADINGS = ['Glossary'];

function stripComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trim();
  }
  return value.trim();
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Splits a flow-sequence body on top-level commas (quotes and braces keep theirs). */
function splitFlow(inner) {
  const items = [];
  let quote = null;
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((x) => unquote(x)).filter(Boolean);
}

/**
 * Minimal YAML front-matter reader for the PART.md schema: `key: scalar`, `key: [a, b]` and the
 * block form Prettier writes for long lists (`key:` then `  - item` lines).
 * Returns { data, body, error }.
 */
export function parseFrontMatter(text) {
  const normalised = text.replace(/\r\n/g, '\n');
  if (!normalised.startsWith('---\n')) {
    return { data: null, body: normalised, error: 'no front-matter' };
  }
  const end = normalised.indexOf('\n---', 4);
  if (end < 0) return { data: null, body: normalised, error: 'front-matter is not closed by ---' };
  const data = {};
  let blockKey = null;
  let flow = null; // { key, text } while a multi-line [ … ] list is open
  for (const [n, line] of normalised.slice(4, end).split('\n').entries()) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (blockKey && !flow && /^\s+\[/.test(line)) flow = { key: blockKey, text: '' };
    if (flow) {
      flow.text += ` ${stripComment(line)}`;
      const t = flow.text.trim();
      if (t.endsWith(']')) {
        data[flow.key] = splitFlow(t.slice(1, -1));
        flow = null;
        blockKey = null;
      }
      continue;
    }
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item && blockKey) {
      const value = unquote(stripComment(item[1]));
      if (value) data[blockKey].push(value);
      continue;
    }
    const m = /^([a-z_]+):(.*)$/.exec(line);
    if (!m) {
      return { data: null, body: '', error: `front-matter line ${n + 2} is not "key: value"` };
    }
    blockKey = null;
    const value = stripComment(m[2]);
    if (value === '') {
      data[m[1]] = [];
      blockKey = m[1];
    } else if (value.startsWith('[')) {
      if (!value.endsWith(']')) flow = { key: m[1], text: value };
      else data[m[1]] = splitFlow(value.slice(1, -1));
    } else {
      data[m[1]] = unquote(value);
    }
  }
  if (flow) return { data: null, body: '', error: `"${flow.key}" list is not closed` };
  return { data, body: normalised.slice(end + 4).replace(/^[^\n]*\n/, ''), error: null };
}

/** `## ` sections of the body: [{ title, content }]. Headings inside code fences are ignored. */
export function sections(body) {
  const out = [];
  let fence = false;
  let current = null;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && /^## (.+?)\s*$/.exec(line);
    if (m) {
      current = { title: m[1].replace(/\s*\(optional\)$/, ''), content: '' };
      out.push(current);
    } else if (current) current.content += `${line}\n`;
  }
  return out;
}

/** Rule IDs defined in the standards: table rows `| SE-2 |` and headings `### IP-1 …`. */
export function definedRuleIds(texts) {
  const ids = new Set();
  const re = /^(?:\|\s*\*{0,2}|#{2,4} )([A-Z]{2,4}-\d+[a-z]?)\b/gm;
  for (const text of texts) for (const m of text.matchAll(re)) ids.add(m[1]);
  return ids;
}

export function citedRuleIds(text, prefixes) {
  const found = new Set();
  for (const m of text.matchAll(/\b([A-Z]{2,4})-(\d+[a-z]?)\b/g)) {
    if (prefixes.has(m[1])) found.add(`${m[1]}-${m[2]}`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// "Was this doc (README or PART.md) read in this session?" (gate)
// ---------------------------------------------------------------------------------------------

/** Transcript of the agent the hook fired in (main session or a subagent). */
export function agentTranscriptPath(transcriptPath, agentId) {
  if (!transcriptPath || !agentId) return transcriptPath || null;
  // Verified layout (hooks docs, SubagentStop): the subagent's own transcript is
  // `<session dir>/subagents/agent-<agent_id>.jsonl` next to the main `<session>.jsonl`.
  const posix = toPosix(transcriptPath);
  const sessionDir = posix.replace(/\.jsonl$/, '');
  return `${sessionDir}/subagents/agent-${agentId}.jsonl`;
}

const READ_COMMAND = /\b(cat|head|tail|less|more|sed|awk|type|gc|Get-Content)\b/i;

/**
 * True when the JSONL transcript text holds a Read tool call (or a single-file read by shell,
 * which Claude Code also counts as a read: memory docs) of `docRel`.
 */
export function transcriptShowsRead(jsonlText, docRel, root = REPO_ROOT, agentId = null) {
  const needle = docRel.toLowerCase();
  const base = path.posix.basename(docRel);
  for (const line of jsonlText.split('\n')) {
    if (!line.includes(base)) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    if (agentId && entry.agentId && entry.agentId !== agentId) continue;
    const content = entry?.message?.content;
    if (entry?.message?.role !== 'assistant' || !Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      const input = block.input ?? {};
      if (block.name === 'Read') {
        const rel = repoRelative(input.file_path, root);
        if (rel && rel.toLowerCase() === needle) return true;
      } else if (block.name === 'Bash' || block.name === 'PowerShell') {
        const cmd = toPosix(String(input.command ?? '')).toLowerCase();
        if (cmd.includes(needle) && READ_COMMAND.test(cmd)) return true;
      }
    }
  }
  return false;
}

/** Records written by the PostToolUse(Read) hook: JSONL of { session_id, agent_id, doc }. */
export function stateShowsRead(stateText, sessionId, agentId, docRel) {
  const doc = docRel.toLowerCase();
  for (const line of stateText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.session_id === sessionId && (r.agent_id ?? null) === (agentId ?? null)) {
        if (String(r.doc).toLowerCase() === doc) return true;
      }
    } catch {
      // a torn line from a concurrent append: ignore it, the transcript is the fallback
    }
  }
  return false;
}

/**
 * Files a shell command writes to: redirection targets, `tee`, `sed -i`, and the PowerShell
 * content cmdlets. Conservative by design (reads and pipes are not writes).
 */
export function shellWriteTargets(command) {
  const cmd = String(command ?? '');
  const targets = [];
  const add = (t) => {
    const clean = t.replace(/^["']|["']$/g, '');
    if (clean && clean !== '/dev/null' && !/^\$null$/i.test(clean) && !/^&\d$/.test(clean)) {
      targets.push(clean);
    }
  };
  for (const m of cmd.matchAll(/(?:^|[^0-9&<>=-])>>?\s*("[^"]+"|'[^']+'|[^\s;|&()<>]+)/g))
    add(m[1]);
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;|&()<>]+)/g)) add(m[1]);
  for (const m of cmd.matchAll(/\bsed\s+-i\S*\s+(.*?)(?:$|[;|&])/gm)) {
    const args = m[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (args.length > 1) add(args[args.length - 1]);
  }
  for (const m of cmd.matchAll(
    /\b(?:Set-Content|Add-Content|Out-File)\b(?:\s+-(?:Path|FilePath|LiteralPath))?\s+("[^"]+"|'[^']+'|[^\s;|&()]+)/gi,
  )) {
    if (!m[1].startsWith('-')) add(m[1]);
  }
  return targets;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
