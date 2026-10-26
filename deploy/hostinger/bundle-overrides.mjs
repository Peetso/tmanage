// npm ignores the root package.json `pnpm.overrides`, so the Hostinger bundle (installed there with
// `npm install`) would not get the transitive security pins the workspace relies on. This turns
// the pnpm overrides into an npm `overrides` object for the bundle's stage manifest, and holds the
// checks the build runs on the bundle's resolved lockfile (security audit NV08): the npm-resolved
// production tree must be the tree pnpm-lock.yaml resolved, and no package may sit below a root
// override floor.

/** A bare package name: `name` or `@scope/name`. */
const NAME = '(?:@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*';
/** `name` or `name@<range>` — one segment of a pnpm override key. */
const SELECTOR = new RegExp(`^(${NAME})(?:@(.+))?$`);

/**
 * One pnpm override key split into its segments: `a@^1>b@<2` is
 * `[{ name: 'a', range: '^1' }, { name: 'b', range: '<2' }]`. Throws on a key it cannot read, so
 * a pin is never silently lost.
 */
export function parseOverrideKey(key) {
  // A `>` that starts a name (`a>b`, `a>@s/b`) chains parents; `>=2`/`>2` inside a range do not.
  return key.split(/>(?=[a-z@])/i).map((segment) => {
    const match = SELECTOR.exec(segment.trim());
    if (!match) throw new Error(`unreadable pnpm override key: ${key}`);
    return { name: match[1], range: match[2] === undefined ? null : match[2].trim() };
  });
}

const segmentKey = (segment) =>
  segment.range === null ? segment.name : `${segment.name}@${segment.range}`;

/**
 * The npm `overrides` for the runtime packages named in `runtimeNames`, translated from
 * `rootPkg.pnpm.overrides`. A pnpm selector key keeps its selector in npm's own syntax
 * (`fast-uri@<3.1.9` stays a `name@range` key; `a>b` becomes `{ a: { b } }`, with `.` holding a's
 * own pin when both exist), so a security pin is no longer dropped (NV08). Names not in
 * `runtimeNames` (dev-only) and pnpm's `-` (remove) value are skipped.
 */
export function npmOverridesFromRoot(rootPkg, runtimeNames = []) {
  const allowed = new Set(runtimeNames);
  const overrides = {};
  for (const [key, value] of Object.entries(rootPkg?.pnpm?.overrides ?? {})) {
    if (typeof value !== 'string' || value === '-') continue;
    const segments = parseOverrideKey(key);
    if (!segments.every((segment) => allowed.has(segment.name))) continue;
    let node = overrides;
    for (const segment of segments.slice(0, -1)) {
      const k = segmentKey(segment);
      if (typeof node[k] === 'string') node[k] = { '.': node[k] };
      node[k] ??= {};
      node = node[k];
    }
    const last = segmentKey(segments[segments.length - 1]);
    if (typeof node[last] === 'object' && node[last] !== null) node[last]['.'] = value;
    else node[last] = value;
  }
  return overrides;
}

// ---- a small semver subset, enough for the override ranges (no dependency: the build runs
// before any bundle install, and npm's semver is not a workspace dependency) ----

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** `x`, `x.y`, `x.y.z` (with `*`/`x` wildcards) as a lower bound plus how many parts were given. */
function parsePartial(text) {
  const match = /^v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-([0-9A-Za-z.-]+))?$/i.exec(
    text,
  );
  if (!match) throw new Error(`unsupported version in range: ${text}`);
  const given = [match[1], match[2], match[3]].filter((p) => p !== undefined && !/^[x*]$/i.test(p));
  const parts = [0, 0, 0];
  given.forEach((p, i) => (parts[i] = Number(p)));
  return { version: { parts, pre: match[4] ?? null }, given: given.length };
}

function bump(version, index) {
  const parts = [...version.parts];
  parts[index] += 1;
  for (let i = index + 1; i < 3; i += 1) parts[i] = 0;
  return { parts, pre: '0' };
}

/** One comparator set (space-separated, all must hold) as [op, version] pairs. */
function comparators(set) {
  const out = [];
  for (const token of set.trim().split(/\s+/).filter(Boolean)) {
    const match = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token);
    const op = match[1] ?? '';
    const { version, given } = parsePartial(match[2]);
    if (op === '^') {
      const index =
        version.parts[0] > 0 || given < 2 ? 0 : version.parts[1] > 0 || given < 3 ? 1 : 2;
      out.push(['>=', version], ['<', bump(version, index)]);
    } else if (op === '~') {
      out.push(['>=', version], ['<', bump(version, given < 2 ? 0 : 1)]);
    } else if ((op === '' || op === '=') && given < 3) {
      if (given > 0) out.push(['>=', version], ['<', bump(version, given - 1)]);
    } else if (op === '>' && given < 3) {
      out.push(['>=', bump(version, Math.max(given - 1, 0))]);
    } else if (op === '<=' && given < 3) {
      out.push(['<', bump(version, Math.max(given - 1, 0))]);
    } else {
      out.push([op === '' ? '=' : op, version]);
    }
  }
  return out;
}

/**
 * Whether `version` satisfies `range` (`||`, space-AND, `>= <= > < =`, `^`, `~`, partials and
 * wildcards). Throws on anything else (hyphen ranges, tags), so a check never passes by not
 * understanding its input.
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) throw new Error(`unsupported version: ${version}`);
  if (/\s-\s/.test(range)) throw new Error(`unsupported range: ${range}`);
  return range.split('||').some((set) =>
    comparators(set).every(([op, bound]) => {
      const c = compareVersions(v, bound);
      if (op === '>=') return c >= 0;
      if (op === '<=') return c <= 0;
      if (op === '>') return c > 0;
      if (op === '<') return c < 0;
      return c === 0;
    }),
  );
}

// ---- pnpm-lock.yaml (v9) reader: the block-mapping subset the lockfile uses ----

function unquote(text) {
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  return text;
}

/** Split `key: value` / `key:` (key possibly quoted); `null` when the line is not a mapping entry. */
function splitEntry(content) {
  let keyEnd;
  if (content.startsWith("'")) {
    let i = 1;
    for (;;) {
      const q = content.indexOf("'", i);
      if (q === -1) return null;
      if (content[q + 1] === "'") {
        i = q + 2;
        continue;
      }
      keyEnd = q + 1;
      break;
    }
  } else if (content.startsWith('"')) {
    const q = content.indexOf('"', 1);
    if (q === -1) return null;
    keyEnd = q + 1;
  } else {
    const sep = content.indexOf(': ');
    keyEnd = sep === -1 ? (content.endsWith(':') ? content.length - 1 : -1) : sep;
    if (keyEnd === -1) return null;
  }
  if (content[keyEnd] !== ':') return null;
  const key = unquote(content.slice(0, keyEnd));
  const rest = content.slice(keyEnd + 1).trim();
  if (rest === '') return { key, value: undefined };
  if (rest === '{}') return { key, value: {} };
  if (rest === '[]') return { key, value: [] };
  return { key, value: unquote(rest) };
}

/** Parse pnpm-lock.yaml text into plain objects (flow values other than `{}`/`[]` stay strings). */
export function parsePnpmLock(text) {
  const root = {};
  const stack = [{ indent: -1, node: root, parent: null, key: null }];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const top = stack[stack.length - 1];
    if (content.startsWith('- ')) {
      if (!Array.isArray(top.node)) {
        if (top.parent === null || Object.keys(top.node).length > 0) {
          throw new Error(`pnpm-lock.yaml: unexpected list item: ${content}`);
        }
        top.node = [];
        top.parent[top.key] = top.node;
      }
      top.node.push(unquote(content.slice(2).trim()));
      continue;
    }
    const entry = splitEntry(content);
    if (!entry || Array.isArray(top.node))
      throw new Error(`pnpm-lock.yaml: unreadable line: ${content}`);
    if (entry.value === undefined) {
      const child = {};
      top.node[entry.key] = child;
      stack.push({ indent, node: child, parent: top.node, key: entry.key });
    } else {
      top.node[entry.key] = entry.value;
    }
  }
  return root;
}

const bareVersion = (resolved) => resolved.split('(')[0];

/**
 * The production `name@version` set pnpm-lock.yaml resolves for the bundle: the `dependencies`
 * of the given importers (the vendored packages) plus the given direct registry dependencies,
 * followed through `snapshots` (dependencies, optionalDependencies, and non-optional peers — the
 * ones npm installs). Workspace `link:` entries are not registry packages and are not counted.
 *
 * @param {object} lock        parsePnpmLock() output
 * @param {string[]} importers importer paths, e.g. 'apps/api'
 * @param {Record<string, string>} direct  extra roots as `{ name: importerPath }` (the stage root's
 *                             registry dependencies, read from that importer's resolution)
 * @returns {Set<string>}
 */
export function pnpmProductionSet(lock, importers, direct = {}) {
  const roots = [];
  for (const path of importers) {
    const importer = lock.importers?.[path];
    if (!importer) throw new Error(`pnpm-lock.yaml has no importer ${path}`);
    for (const [name, dep] of Object.entries(importer.dependencies ?? {})) {
      roots.push([name, dep.version]);
    }
  }
  for (const [name, path] of Object.entries(direct)) {
    const dep =
      lock.importers?.[path]?.dependencies?.[name] ??
      lock.importers?.[path]?.devDependencies?.[name];
    if (!dep) throw new Error(`pnpm-lock.yaml: ${path} does not resolve ${name}`);
    roots.push([name, dep.version]);
  }
  const set = new Set();
  const seen = new Set();
  const queue = roots.filter(([, version]) => !version.startsWith('link:'));
  while (queue.length > 0) {
    const [name, resolved] = queue.pop();
    const snapshotKey = `${name}@${resolved}`;
    if (seen.has(snapshotKey)) continue;
    seen.add(snapshotKey);
    const version = bareVersion(resolved);
    set.add(`${name}@${version}`);
    const snapshot = lock.snapshots?.[snapshotKey];
    if (snapshot === undefined) throw new Error(`pnpm-lock.yaml has no snapshot ${snapshotKey}`);
    const meta = lock.packages?.[`${name}@${version}`] ?? {};
    const optionalPeers = new Set(
      Object.entries(meta.peerDependenciesMeta ?? {})
        .filter(([, m]) => m && m.optional === 'true')
        .map(([peer]) => peer),
    );
    for (const field of ['dependencies', 'optionalDependencies']) {
      for (const [dep, depResolved] of Object.entries(snapshot[field] ?? {})) {
        if (optionalPeers.has(dep) || depResolved.startsWith('link:')) continue;
        queue.push([dep, depResolved]);
      }
    }
  }
  return set;
}

/**
 * The bundle's whole npm `overrides`: the translated root pins ({@link npmOverridesFromRoot}, for
 * every name in the production set) plus an exact pin for every production package pnpm resolved
 * to a single version, so `npm install` reproduces pnpm-lock.yaml's tree instead of the newest
 * patch the registry serves that day (NV08: without the pins 30 of 240 packages drifted). The
 * stage root's own direct dependencies are not pinned here (npm refuses an override that differs
 * from a direct dependency, and they are already exact). A name with several versions keeps only
 * its root pins; the lockfile comparison catches any drift there.
 *
 * @param {object} rootPkg       the root package.json
 * @param {Set<string>} pnpmSet  pnpmProductionSet() output
 * @param {string[]} directNames the stage root's direct dependency names
 */
export function bundleOverrides(rootPkg, pnpmSet, directNames = []) {
  const versions = new Map();
  for (const item of pnpmSet) {
    const at = item.lastIndexOf('@');
    const name = item.slice(0, at);
    versions.set(name, [...(versions.get(name) ?? []), item.slice(at + 1)]);
  }
  const overrides = npmOverridesFromRoot(rootPkg, [...versions.keys()]);
  const direct = new Set(directNames);
  for (const [name, list] of [...versions.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (direct.has(name)) continue;
    if (list.length === 1) {
      if (typeof overrides[name] === 'object' && overrides[name] !== null) {
        overrides[name]['.'] = list[0];
      } else {
        overrides[name] = list[0];
      }
      continue;
    }
    // Several versions: pin each caret line (`name@^6`, `name@^0.3`) that holds exactly one of
    // them, unless a root selector already speaks for that name.
    if (Object.keys(overrides).some((key) => key.startsWith(`${name}@`))) continue;
    const lines = new Map();
    for (const version of list) {
      const [major, minor] = version.split('.');
      const line = major === '0' ? `^0.${minor}` : `^${major}`;
      lines.set(line, [...(lines.get(line) ?? []), version]);
    }
    for (const [line, inLine] of lines) {
      if (inLine.length === 1) overrides[`${name}@${line}`] = inLine[0];
    }
  }
  return overrides;
}

/** The registry packages of an npm v2+ lockfile as `name@version` (no dev, no links, no @tmanage). */
export function npmLockProductionSet(lock) {
  const set = new Set();
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (key === '' || !entry || entry.dev === true || entry.link === true) continue;
    if (!key.includes('node_modules/')) continue;
    if (typeof entry.resolved === 'string' && entry.resolved.startsWith('file:')) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (name.startsWith('@tmanage/')) continue;
    set.add(`${name}@${entry.version}`);
  }
  return set;
}

/** What one set has that the other lacks, sorted. */
export function compareProductionSets(npmSet, pnpmSet) {
  const onlyNpm = [...npmSet].filter((x) => !pnpmSet.has(x)).sort();
  const onlyPnpm = [...pnpmSet].filter((x) => !npmSet.has(x)).sort();
  return { onlyNpm, onlyPnpm, same: onlyNpm.length === 0 && onlyPnpm.length === 0 };
}

/**
 * Every `name@version` in `set` that a root pnpm override should have moved: the version matches
 * the override's selector (any version for a plain key; for `a>b` the last segment's) yet does not
 * satisfy the override's value. `-` (remove) and non-range values (`npm:`, `link:`) are skipped.
 */
export function overrideFloorViolations(set, rootOverrides) {
  const violations = [];
  for (const [key, value] of Object.entries(rootOverrides ?? {})) {
    if (typeof value !== 'string' || value === '-' || /^[a-z]+:/i.test(value)) continue;
    const target = parseOverrideKey(key).at(-1);
    for (const item of set) {
      const at = item.lastIndexOf('@');
      if (item.slice(0, at) !== target.name) continue;
      const version = item.slice(at + 1);
      if (target.range !== null && !satisfies(version, target.range)) continue;
      if (!satisfies(version, value)) violations.push(`${item} (override ${key}: ${value})`);
    }
  }
  return violations.sort();
}
