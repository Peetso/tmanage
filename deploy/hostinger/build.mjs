// Build the Hostinger deployment bundle: deploy/hostinger/out/tmanage-hostinger.zip
//
// The zip is code-only and self-describing — built packages, the Next.js production build, the
// migrations, and a package.json that `npm install` on Hostinger (Linux) resolves. It ships NO
// node_modules on purpose: @node-rs/argon2 (and Next's swc) are native, and the correct binary
// for Hostinger's platform is the one `npm install` fetches there, not the Windows one a local
// install would bake in. The private @tmanage/* packages travel inside the zip under vendor/ and
// are referenced by `file:` so npm links them without a registry.
//
// Usage: pnpm deploy:hostinger   (from the repo root)
//
// The bundle is built from the working checkout, so it refuses to start while the files that feed
// it (apps/, packages/, the lockfile, the root manifests) differ from HEAD: a zip built from other
// runs' uncommitted edits is not the commit it is named after. TMANAGE_BUNDLE_ALLOW_DIRTY=1
// overrides that and prints what was included. After the build it checks that .next is fresh and
// that the prerendered pages hold their own content (live-check 014a9d51, routes L2).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bundleOverrides,
  compareProductionSets,
  npmLockProductionSet,
  overrideFloorViolations,
  parsePnpmLock,
  pnpmProductionSet,
} from './bundle-overrides.mjs';
import { webChildPublicConfig } from '../../apps/server/web-transport.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = join(HERE, 'out');
const STAGE = join(OUT, 'stage');
const ZIP = join(OUT, 'tmanage-hostinger.zip');

/** Paths whose uncommitted changes would change what the bundle contains. */
const BUNDLE_INPUTS = [
  'apps/',
  'packages/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
];

/**
 * The bundle inputs that `git status --porcelain` reports as changed or untracked.
 *
 * @param {string} porcelain  the output of `git status --porcelain` (v1)
 * @returns {string[]} the changed paths under BUNDLE_INPUTS, forward-slashed
 */
export function dirtyBundleInputs(porcelain) {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      const path = line.slice(3).trim();
      // A rename reads `old -> new`; the new path is what the build sees.
      const target = path.includes(' -> ') ? path.split(' -> ').pop() : path;
      return target.replace(/^"|"$/g, '');
    })
    .filter((path) =>
      BUNDLE_INPUTS.some((input) =>
        input.endsWith('/') ? path.startsWith(input) : path === input,
      ),
    );
}

/**
 * The public site's origin, as apps/web/src/lib/site-origin.ts derives it: the hreflang
 * alternates carry absolute URLs (agent-ready site, c44d28e4).
 */
const SITE_ORIGIN = (process.env['TMANAGE_SITE_URL']?.trim() || 'https://tmanageapp.com').replace(
  /\/+$/,
  '',
);

/**
 * Applied migrations whose bytes must never change, by sha256. The migrator records each file's
 * checksum and refuses to start ("Checksum mismatch") when a recorded file differs. 0208 names
 * the old host (tmanage.peetrix.com) in a comment; on 2026-11-17 Hostinger's domain change
 * rewrote that address inside the server's files and the live start failed until the owner
 * restored the file by hand. The text, old address included, stays byte-identical forever.
 */
export const PINNED_MIGRATIONS = Object.freeze({
  '0208_oauth_core.sql': 'd6cc88c7c8d1bd4489e50b2398adc1ba80a0dd1eec5fa482da784429208826dd',
});

/**
 * What is wrong with the pinned migrations in `dir` (a migrations folder): a missing file or a
 * different sha256. Empty when every pinned file is present with its pinned bytes.
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function pinnedMigrationProblems(dir) {
  return Object.entries(PINNED_MIGRATIONS).flatMap(([name, expected]) => {
    const file = join(dir, name);
    if (!existsSync(file)) return [`${name} is missing from ${dir}`];
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    return actual === expected ? [] : [`${name} has sha256 ${actual}, pinned ${expected}`];
  });
}

/**
 * What a bundle's start log says went wrong that must fail the deploy check loudly: the migrator's
 * "Checksum mismatch" (an applied migration's bytes changed, see PINNED_MIGRATIONS).
 *
 * @param {string} log  the server's combined stdout and stderr
 * @returns {string[]}
 */
export function startLogProblems(log) {
  const line = log.split(/\r?\n/).find((l) => l.includes('Checksum mismatch'));
  return line === undefined ? [] : [`migration checksum mismatch on start: ${line.trim()}`];
}

/**
 * A string from the web app's message catalog (apps/web/src/lib/i18n/messages/<locale>.json), so
 * a rule checks the words the page really renders: a wording change in the catalog moves the
 * rule with it instead of failing the deploy build (the Arabic 404 heading, CONFIRMPOLISH 5).
 * Throws when the key is missing or empty, so a renamed key cannot turn a rule into a no-op.
 *
 * @param {string} locale  catalog file name without `.json`, e.g. `en` or `ar`
 * @param {string} key     a flat catalog key, e.g. `StateScreens.notFoundTitle`
 * @returns {string} the catalog's text for `key`
 */
export function webCatalogText(locale, key) {
  const file = join(REPO, 'apps/web/src/lib/i18n/messages', `${locale}.json`);
  const value = JSON.parse(readFileSync(file, 'utf8'))[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${file} has no text for '${key}'`);
  }
  return value;
}

/**
 * Pages whose prerendered HTML is checked in the bundle and on the running server. Each page
 * must hold its own text and none of the page it was once confused with (live-check 014a9d51:
 * /features/communication was reported as the Privacy Policy and /status as the setup screen).
 * HTML entities are decoded for `&amp;` only, which is all these strings need. <script> contents
 * are dropped before matching: every page ships an inline title dictionary (the locale boot) that
 * names every page title, 'Privacy Policy' included, and must neither trip a hasNot nor satisfy a has.
 */
export const ROUTE_CONTENT = [
  {
    path: '/features/communication',
    file: 'features/communication.html',
    has: ['Chat & calendar'],
    hasNot: ['Privacy Policy', 'setup token'],
  },
  {
    path: '/status',
    file: 'status.html',
    has: ['tm-pub-eyebrow">Status<', 'Service status'],
    hasNot: ['setup token', 'Create the owner account', 'Privacy Policy'],
  },
  {
    path: '/legal/privacy',
    file: 'legal/privacy.html',
    has: ['Privacy Policy', 'Effective'],
    hasNot: ['setup token'],
  },
  // The Arabic public pages (NFR-02, audit gap 5): Arabic language, direction and title in the HTML.
  {
    path: '/ar',
    file: 'ar.html',
    has: ['<html lang="ar" dir="rtl"', `hrefLang="en" href="${SITE_ORIGIN}/"`],
    hasNot: ['<html lang="en"', 'setup token'],
  },
  {
    path: '/ar/pricing',
    file: 'ar/pricing.html',
    has: ['<html lang="ar" dir="rtl"', '<title>الأسعار · TManage</title>'],
    hasNot: ['<html lang="en"', '<title>Pricing · TManage</title>', 'setup token'],
  },
  // NOTFOUND (live 2026-11-16): the 404 page is the full not-found screen, never an empty body.
  // A not-found page answers 404 on the running server too (`status`; every other rule is 200).
  {
    path: '/_not-found',
    file: '_not-found.html',
    status: 404,
    // The heading NotFoundState renders, from the catalog (`StateScreens.notFoundTitle`).
    has: [webCatalogText('en', 'StateScreens.notFoundTitle'), 'href="/sign-in"'],
    hasNot: ['setup token'],
  },
  // NEXTUP: the Arabic 404 an unknown /ar/... path is answered with, Arabic and right to left.
  {
    path: '/ar/page-not-found',
    file: 'ar/page-not-found.html',
    status: 404,
    has: [
      '<html lang="ar" dir="rtl"',
      webCatalogText('ar', 'StateScreens.notFoundTitle'),
      'href="/ar"',
    ],
    hasNot: ['<html lang="en"', 'setup token'],
  },
];

/**
 * What is wrong with `html` as the page at `path`, or `[]` when it holds its own content.
 *
 * @param {string} path  one of ROUTE_CONTENT's paths
 * @param {string} html  the page's HTML (server response or prerendered file)
 * @returns {string[]} one sentence per problem
 */
export function routeContentProblems(path, html) {
  const rule = ROUTE_CONTENT.find((entry) => entry.path === path);
  if (!rule) return [`no content rule for ${path}`];
  // React escapes ' and " in text; catalog strings are matched as written.
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');
  return [
    ...rule.has.filter((s) => !text.includes(s)).map((s) => `${path} is missing '${s}'`),
    ...rule.hasNot.filter((s) => text.includes(s)).map((s) => `${path} contains '${s}'`),
  ];
}

/**
 * Whether the web build in `.next` was produced by this run: its BUILD_ID must be written at or
 * after `startedAtMs`. A BUILD_ID older than the run means the build step did not replace it and
 * an earlier build would be shipped.
 */
export function isFreshBuild(buildIdMtimeMs, startedAtMs) {
  return buildIdMtimeMs >= startedAtMs;
}

function refuseDirtyCheckout() {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (status.status !== 0) throw new Error(`git status failed: ${status.stderr}`);
  const dirty = dirtyBundleInputs(status.stdout);
  if (dirty.length === 0) return;
  const list = dirty.map((p) => `  ${p}`).join('\n');
  if (process.env['TMANAGE_BUNDLE_ALLOW_DIRTY'] === '1') {
    process.stdout.write(`\nTMANAGE_BUNDLE_ALLOW_DIRTY=1 — the bundle includes:\n${list}\n`);
    return;
  }
  throw new Error(
    `the checkout differs from HEAD in ${dirty.length} bundle input(s); commit them or build ` +
      `from a clean export (TMANAGE_BUNDLE_ALLOW_DIRTY=1 to include them anyway):\n${list}`,
  );
}

function verifyWebBuild(startedAtMs) {
  const next = join(REPO, 'apps/web/.next');
  const buildId = join(next, 'BUILD_ID');
  if (!existsSync(buildId) || !isFreshBuild(statSync(buildId).mtimeMs, startedAtMs)) {
    throw new Error(`${buildId} predates this run — the web build did not replace .next`);
  }
  const problems = ROUTE_CONTENT.flatMap((rule) => {
    const file = join(next, 'server/app', rule.file);
    if (!existsSync(file)) return [`${rule.path} was not prerendered (${rule.file} missing)`];
    return routeContentProblems(rule.path, readFileSync(file, 'utf8'));
  });
  if (problems.length > 0) {
    throw new Error(`the web build serves the wrong content:\n  ${problems.join('\n  ')}`);
  }
}

/** Value (non-`import type`) relative imports of a TS module: `from './x'` → `./x`. */
function relativeValueImports(source) {
  return [
    ...source.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+'(\.{1,2}\/[^']+)';/gm),
  ].map((match) => match[1]);
}

/** Point every extensionless relative specifier in emitted JS at its shipped `.mjs` file. */
function withMjsSpecifiers(js) {
  return js.replace(
    /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)'(\.{1,2}\/[^']+?)'/g,
    (whole, lead, spec) => (/\.[cm]?js$/.test(spec) ? whole : `${lead}'${spec}.mjs'`),
  );
}

/**
 * Convert the web app's `next.config.ts` (and every local module it imports, transitively) to
 * plain ES modules: `next.config.mjs` plus `<module>.mjs` files at the same relative paths.
 *
 * `next start` loads a `.ts` config through Next's native SWC binary, and Hostinger's shared-
 * hosting Linux is too old for it (GLIBC_2.29 missing — the 2026-10-17 live deploy could not
 * start until the config was shipped pre-converted by hand). A `.mjs` config is loaded by plain
 * Node, so the bundle never needs SWC at runtime. The conversion is a type-strip
 * (`ts.transpileModule`), so the shipped config is the repository's config, not a copy of it.
 *
 * @param {object} options
 * @param {typeof import('typescript')} options.ts  the TypeScript compiler module
 * @param {string} options.webDir  the source directory holding next.config.ts
 * @param {string} options.outDir  where to write next.config.mjs and the converted modules
 * @returns {string[]} the written files, relative to outDir, forward-slashed
 */
export function convertNextConfig({ ts, webDir, outDir }) {
  const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: false,
  };
  const written = [];
  const queue = ['next.config.ts'];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const rel = queue.shift();
    const source = readFileSync(join(webDir, rel), 'utf8');
    for (const spec of relativeValueImports(source)) {
      const target = join(dirname(rel), `${spec}.ts`).replaceAll('\\', '/');
      if (!existsSync(join(webDir, target))) {
        throw new Error(`${rel} imports ${spec}, which is not a .ts module beside it`);
      }
      if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
    const { outputText, diagnostics } = ts.transpileModule(source, {
      compilerOptions,
      fileName: rel,
      reportDiagnostics: true,
    });
    if (diagnostics && diagnostics.length > 0) {
      const text = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      throw new Error(`cannot convert ${rel}: ${text.join('; ')}`);
    }
    const outRel = rel.replace(/\.ts$/, '.mjs');
    mkdirSync(dirname(join(outDir, outRel)), { recursive: true });
    writeFileSync(join(outDir, outRel), withMjsSpecifiers(outputText));
    written.push(outRel);
  }
  return written;
}

/**
 * Load the staged `next.config.mjs` as the bundle's `next start` will, and return the resolved
 * configuration (route rules resolved too), or throw a sentence naming what broke.
 *
 * The config runs again at every start, from a directory that holds the build and none of the
 * sources. On 2026-11-18 it read the i18n catalog sources at load, so the web child crash-looped
 * on Hostinger (ENOENT `web/src/lib/i18n/messages`) while every local check passed. This runs the
 * staged file in a fresh Node process with the staged directory as its working directory, the
 * web child's production environment and Next's production-server phase. The stage has no
 * node_modules, so a package it imports resolves from the web workspace, whose versions the
 * bundle pins (workspace-resolve.hooks.mjs); a staged file that is missing still fails.
 *
 * @param {object} options
 * @param {string} options.webDir  the staged web directory holding next.config.mjs
 * @param {string} [options.workspaceDir]  the web workspace packages resolve from (apps/web)
 * @returns {Record<string, unknown>} the resolved configuration, as the loader printed it
 */
export function loadStagedNextConfig({ webDir, workspaceDir = join(REPO, 'apps/web') }) {
  const result = spawnSync(
    process.execPath,
    [join(HERE, 'load-next-config.child.mjs'), workspaceDir],
    {
      cwd: webDir,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], NODE_ENV: 'production', ...webChildPublicConfig({}) },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${join(webDir, 'next.config.mjs')} does not load the way the bundle's \`next start\` ` +
        `loads it, so the deployed web server would crash on every start:\n${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout);
}

/**
 * The exact version of `name` as it is actually installed for the workspace package in `fromDir`.
 *
 * Dependencies are pinned to these exact versions in the bundle, not to the source packages'
 * caret ranges. A range let the bundle's `npm install` pull a newer Next (16.4.2) than the one
 * the .next build was produced with (16.3.3); a production build served by a different Next minor
 * fails SSR (undefined preview props). Exact pins make the installed tree match the built tree.
 */
function exactVersion(name, fromDir) {
  // Read the installed package.json directly rather than via require.resolve: some packages
  // (e.g. drizzle-orm) do not export './package.json', which makes resolve throw. Every dependency
  // asked about here is a DIRECT dependency of the package in fromDir, so pnpm links it at
  // node_modules/<name> there.
  const pkgPath = join(REPO, fromDir, 'node_modules', ...name.split('/'), 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

// The private packages that must travel in the bundle. config/domain/mail/storage/contracts/ui
// have no @tmanage siblings; api and worker do, and those workspace specifiers are rewritten to
// file: links below.
// mcp-server (apps/mcp-server) has none either; the api depends on it for the hosted `/mcp` endpoint.
const VENDOR_PKGS = [
  'config',
  'domain',
  'mail',
  'storage',
  'contracts',
  'ui',
  'mcp-server',
  'worker',
  'api',
];

/**
 * Non-dist trees a vendored package reads at run time, copied next to its dist/: ui ships its raw
 * style sources; the api ships the fonts record-pdf.ts embeds (it resolves `assets/fonts` from
 * dist/modules/approvals/, so without them Arabic in a sealed PDF prints as "?").
 */
export const VENDOR_EXTRA_TREES = Object.freeze({
  ui: Object.freeze(['src/styles']),
  api: Object.freeze(['assets/fonts']),
});

/**
 * The stage root's direct registry dependencies, each with the workspace package whose resolved
 * version it is pinned to (and whose pnpm-lock.yaml resolution the lockfile check starts from).
 */
export const BUNDLE_DIRECT_DEPENDENCIES = Object.freeze({
  '@tanstack/react-query': 'apps/web',
  next: 'apps/web',
  react: 'apps/web',
  'react-dom': 'apps/web',
  'reflect-metadata': 'apps/api',
});

/**
 * Run a command. Throws on a non-zero exit — except with `{ capture: true }`, where the caller
 * reads the exit itself: stdout is captured (stderr still shows) and `{ status, stdout }` returned.
 */
function run(cmd, args, env, cwd = REPO, options = {}) {
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
    ...(options.capture ? { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 } : {}),
  });
  if (options.capture) {
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout ?? '' };
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status ?? 'null'}`);
  }
}

/**
 * Copy a tree, skipping the paths a deployment never needs — and every source map: the bundle
 * ships no `*.map`, so a future file-read misconfiguration has no source to hand out (pre-launch
 * security review 2026-10-17, §3).
 */
function copyTree(from, to, skip = []) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) =>
      !src.endsWith('.map') &&
      !skip.some((s) => src === join(from, s) || src.startsWith(join(from, s))),
  });
}

/** A vendored package.json: runtime fields only, workspace:* rewritten to file: links. */
function vendorManifest(dir) {
  const raw = JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8'));
  const deps = {};
  for (const [name, spec] of Object.entries(raw.dependencies ?? {})) {
    // Sibling private packages sit beside this one under vendor/@tmanage/<name>; every registry
    // dependency is pinned to the exact version this package actually resolves, so the bundle's
    // install reproduces the tree the build was made against.
    deps[name] =
      spec === 'workspace:*' ? `file:../${name.replace('@tmanage/', '')}` : exactVersion(name, dir);
  }
  const manifest = {
    name: raw.name,
    version: raw.version,
    private: true,
    type: raw.type,
    main: raw.main,
    types: raw.types,
    exports: raw.exports,
    files: raw.files,
    dependencies: deps,
  };
  if (raw.peerDependencies) manifest.peerDependencies = raw.peerDependencies;
  return manifest;
}

/**
 * The `/v1` rewrite target the web build bakes in (security audit NV05). server.mjs answers every
 * `/v1` path itself and refuses case/escape variants before Next sees them, so the rewrite is never
 * meant to be dialled; it still has to name an origin for the public-config validation. Port 1 is
 * privileged, so no process of a shared-hosting account can listen there and receive the visitor's
 * cookies if a request ever slipped through (the old value, port 3000, could be bound by anyone).
 */
export const WEB_BUILD_API_PROXY_TARGET = webChildPublicConfig({}).API_PROXY_TARGET;

/**
 * What the bundle's `.npmrc` says (security audit NV08). `install-links`/`bin-links` as before
 * (Hostinger's sandbox refuses symlinks); `ignore-scripts=true` so no dependency's
 * preinstall/install/postinstall runs at Hostinger install time. `npm run build`/`npm start`
 * still run the root's own named scripts — npm only skips lifecycle hooks under this setting.
 */
export const BUNDLE_NPMRC = 'install-links=true\nbin-links=false\nignore-scripts=true\n';

/**
 * Packages allowed to need an install script. npm has no per-package allowlist, so with
 * `ignore-scripts=true` this list is the review gate instead: the build fails when the pinned tree
 * gains a package that declares one, until someone decides it here. Empty: the runtime tree has
 * none (checked 2026-10-25: 253 packages, no `hasInstallScript`).
 */
export const INSTALL_SCRIPT_ALLOWLIST = Object.freeze([]);

/**
 * High/critical advisories the build accepts after review (audit run 2, NO-GO reason 1). npm audit
 * has no per-advisory ignore, so this list is the gate, as INSTALL_SCRIPT_ALLOWLIST is for install
 * scripts: an entry names one GHSA id for one exact `package@version`, so the same advisory on any
 * other version, any other advisory, or an entry older than {@link AUDIT_ALLOWLIST_MAX_AGE_DAYS}
 * fails the build again. An entry is `{ id, package, reason, reviewed }` (see the tests' fixture).
 */
export const AUDIT_ADVISORY_ALLOWLIST = Object.freeze([
  // Empty since wave 13 (2026-10-26): zod moved to 4.6.x, which fixes GHSA-mrhx-c7xc-m3w5, the only
  // entry this list ever held (zod@3.25.76). The staged tree has no high or critical advisory.
]);

/** An allowlist entry older than this fails the build until someone reviews it again. */
export const AUDIT_ALLOWLIST_MAX_AGE_DAYS = 90;

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/**
 * Read `npm audit --json` and return the high/critical advisories not covered by the allowlist,
 * as `GHSA-id package@version (severity)` strings. Throws on a report it cannot read, so a broken
 * or empty audit is never a pass.
 *
 * @param {string} reportText   npm audit --json stdout
 * @param {object} lock         the staged package-lock.json (for the installed versions)
 * @param {ReadonlyArray<{id: string, package: string, reviewed: string}>} allowlist
 * @param {Date} now
 * @returns {string[]}
 */
export function unallowedAuditFindings(
  reportText,
  lock,
  allowlist = AUDIT_ADVISORY_ALLOWLIST,
  now = new Date(),
) {
  let report;
  try {
    report = JSON.parse(reportText);
  } catch {
    throw new Error('npm audit --json printed no readable report');
  }
  if (report === null || typeof report !== 'object' || report.error) {
    throw new Error(`npm audit failed: ${JSON.stringify(report?.error ?? report)}`);
  }
  const vulnerabilities = report.vulnerabilities;
  if (vulnerabilities === null || typeof vulnerabilities !== 'object') {
    throw new Error('npm audit --json report has no vulnerabilities object');
  }
  const versionsOf = (name) =>
    [
      ...new Set(
        Object.entries(lock.packages ?? {})
          .filter(
            ([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`),
          )
          .map(([, entry]) => entry?.version)
          .filter((v) => typeof v === 'string'),
      ),
    ].sort();
  const maxAgeMs = AUDIT_ALLOWLIST_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const allowed = (id, name, versions) =>
    allowlist.some((entry) => {
      const reviewed = Date.parse(entry.reviewed);
      if (!Number.isFinite(reviewed) || now.getTime() - reviewed > maxAgeMs) return false;
      if (entry.id !== id) return false;
      // Every installed copy of the package must be the reviewed version.
      return versions.length > 0 && versions.every((v) => `${name}@${v}` === entry.package);
    });

  const findings = new Set();
  let serious = 0;
  for (const [key, vuln] of Object.entries(vulnerabilities)) {
    if ((SEVERITY_RANK[vuln?.severity] ?? 0) < SEVERITY_RANK.high) continue;
    serious += 1;
    for (const via of vuln.via ?? []) {
      // A string `via` is another vulnerable package of this report; it is judged on its own entry.
      if (typeof via === 'string') continue;
      if ((SEVERITY_RANK[via?.severity] ?? SEVERITY_RANK.critical) < SEVERITY_RANK.high) continue;
      const name = via.name ?? vuln.name ?? key;
      const id = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(String(via.url ?? ''))?.[0];
      const versions = versionsOf(name);
      const label = `${id ?? `advisory ${via.source ?? '?'}`} ${name}@${versions.join('|') || '?'} (${via.severity ?? vuln.severity})`;
      if (id === undefined || !allowed(id, name, versions)) findings.add(label);
    }
    // A high entry whose cause is not itself in the report cannot be judged: refuse it.
    const viaNames = (vuln.via ?? []).filter((v) => typeof v === 'string');
    if ((vuln.via ?? []).length === 0 || viaNames.some((n) => !(n in vulnerabilities))) {
      findings.add(`${key} (${vuln.severity}, unexplained by the report)`);
    }
  }
  const counted =
    (report.metadata?.vulnerabilities?.high ?? 0) +
    (report.metadata?.vulnerabilities?.critical ?? 0);
  if (counted > serious) {
    findings.add(`npm audit counts ${counted} high/critical but lists ${serious}`);
  }
  return [...findings].sort();
}

/**
 * Pin the bundle's whole install (security audit NV08). Writes {@link BUNDLE_NPMRC} and a
 * `package-lock.json` resolved at bundle build time (`npm install --package-lock-only
 * --ignore-scripts`, nothing executed, no node_modules written), so Hostinger's `npm install`
 * installs the transitive tree this build was made and reviewed against rather than whatever the
 * registry serves on deploy day. Throws when the lockfile is missing or names a package with an
 * install script that is not on {@link INSTALL_SCRIPT_ALLOWLIST}.
 *
 * Run 2 of the audit (NV08 partial): the lockfile npm resolved is no longer trusted as-is. The
 * build also fails when its production `name@version` set differs from `pnpmSet` (the tree
 * pnpm-lock.yaml resolved, which the tests and reviews ran against), when any package sits below a
 * root `pnpm.overrides` floor, and when `npm audit --omit=dev --audit-level=high --json` reports a
 * high or critical advisory for the staged tree that {@link AUDIT_ADVISORY_ALLOWLIST} does not
 * name for the exact installed version.
 *
 * @param {string} stageDir   the staged bundle root (holds package.json and vendor/)
 * @param {(cmd: string, args: string[], env: object | undefined, cwd: string,
 *   options?: { capture?: boolean }) => void | { status: number | null, stdout: string }} runner
 *   throws on failure; with `capture` returns the exit status and stdout instead
 * @param {{ pnpmSet: Set<string>, rootOverrides?: Record<string, string>,
 *   auditAllowlist?: typeof AUDIT_ADVISORY_ALLOWLIST, now?: Date }} expected
 *   pnpmProductionSet() output and the root package.json `pnpm.overrides`; required
 * @returns {{ packages: number, installScripts: string[] }}
 */
export function stageInstallPins(stageDir, runner = run, expected = undefined) {
  if (!(expected?.pnpmSet instanceof Set) || expected.pnpmSet.size === 0) {
    throw new Error('stageInstallPins needs the pnpm-lock.yaml production set to compare against');
  }
  writeFileSync(join(stageDir, '.npmrc'), BUNDLE_NPMRC);
  runner(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    undefined,
    stageDir,
  );
  const lockPath = join(stageDir, 'package-lock.json');
  if (!existsSync(lockPath)) throw new Error('the bundle has no package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!(lock.lockfileVersion >= 2) || typeof lock.packages !== 'object' || lock.packages === null) {
    throw new Error('the bundle package-lock.json is not a v2+ lockfile');
  }
  const installScripts = Object.entries(lock.packages)
    .filter(([, entry]) => entry && entry.hasInstallScript === true)
    .map(([key, entry]) => `${key.replace(/^.*node_modules\//, '')}@${entry.version ?? '?'}`);
  const unreviewed = installScripts.filter(
    (name) => !INSTALL_SCRIPT_ALLOWLIST.includes(name.replace(/@[^@]*$/, '')),
  );
  if (unreviewed.length > 0) {
    throw new Error(
      `bundle dependencies with install scripts not on INSTALL_SCRIPT_ALLOWLIST: ${unreviewed.join(', ')}`,
    );
  }
  const npmSet = npmLockProductionSet(lock);
  const drift = compareProductionSets(npmSet, expected.pnpmSet);
  if (!drift.same) {
    throw new Error(
      "the bundle package-lock.json does not match pnpm-lock.yaml's production tree" +
        `\n  only in the bundle lock: ${drift.onlyNpm.join(', ') || '-'}` +
        `\n  only in pnpm-lock.yaml: ${drift.onlyPnpm.join(', ') || '-'}`,
    );
  }
  const belowFloor = overrideFloorViolations(npmSet, expected.rootOverrides ?? {});
  if (belowFloor.length > 0) {
    throw new Error(`bundle packages below a root override floor: ${belowFloor.join(', ')}`);
  }
  // Read-only: audits the staged lockfile against the registry's advisories. A high or critical
  // advisory that is not on AUDIT_ADVISORY_ALLOWLIST for the exact installed version throws, so
  // no bundle is zipped; so does a report that cannot be read.
  const audit = runner(
    'npm',
    ['audit', '--omit=dev', '--audit-level=high', '--json'],
    undefined,
    stageDir,
    { capture: true },
  );
  if (audit === null || typeof audit !== 'object' || typeof audit.stdout !== 'string') {
    throw new Error('npm audit returned no report');
  }
  const unallowed = unallowedAuditFindings(
    audit.stdout,
    lock,
    expected.auditAllowlist ?? AUDIT_ADVISORY_ALLOWLIST,
    expected.now ?? new Date(),
  );
  if (unallowed.length > 0) {
    throw new Error(
      `npm audit: high/critical advisories not on AUDIT_ADVISORY_ALLOWLIST: ${unallowed.join(', ')}`,
    );
  }
  if (audit.status !== 0 && audit.status !== 1) {
    throw new Error(`npm audit exited ${audit.status ?? 'null'}`);
  }
  return { packages: Object.keys(lock.packages).length, installScripts };
}

function buildArtifacts() {
  run('pnpm', ['build:packages']);
  run('pnpm', ['--filter', '@tmanage/worker', 'build']);
  run('pnpm', ['--filter', '@tmanage/api', 'build']);
  // The web build inlines NEXT_PUBLIC_* at compile time: same-origin topology, the documented
  // default cookie name, and a loopback proxy target the runtime never actually dials (the
  // single process answers /v1, and refuses its case variants, before Next's rewrite would). The project's own build script
  // (Turbopack, the Next 16 default) is used as-is; the bundle serves that build with
  // `next start`, which is the server it is made for.
  // The values are the web child's defaults (apps/server/web-transport.mjs), so the config that
  // `next start` re-validates on Hostinger sees exactly what this build inlined.
  run('pnpm', ['--filter', '@tmanage/web', 'build'], {
    NODE_ENV: 'production',
    ...webChildPublicConfig({}),
  });
}

/**
 * The Windows desktop installer the site serves at /downloads/TManage-Setup.exe (Figma 409:6602;
 * allow-listed in apps/server/boot-guards.mjs). electron-builder writes it, unsigned and never
 * published, to apps/desktop/release (git-ignored); the bundle carries it under downloads/ with
 * its SHA-256. It needs Windows to build, so elsewhere — or with TMANAGE_BUNDLE_SKIP_DESKTOP=1 —
 * the step is skipped and the route answers 503 until a bundle with the installer is deployed.
 */
export const DESKTOP_INSTALLER_NAME = 'TManage-Setup.exe';

/** electron-builder's default NSIS artifact name for this product and version. */
export function desktopArtifactName(version) {
  return `TManage Setup ${version}.exe`;
}

function buildDesktopInstaller() {
  if (process.env['TMANAGE_BUNDLE_SKIP_DESKTOP'] === '1' || process.platform !== 'win32') {
    process.stdout.write('\ndesktop installer: skipped (needs Windows; /downloads answers 503)\n');
    return undefined;
  }
  run('pnpm', ['--filter', '@tmanage/desktop', 'dist']);
  const { version } = JSON.parse(readFileSync(join(REPO, 'apps/desktop/package.json'), 'utf8'));
  const built = join(REPO, 'apps/desktop/release', desktopArtifactName(version));
  if (!existsSync(built)) throw new Error(`electron-builder did not write ${built}`);
  return built;
}

/**
 * Copy `source` into `<stageDir>/downloads/<name>` with a `sha256sum`-style `<name>.sha256` beside
 * it. Returns the checksum and the size in bytes.
 */
export function stageDownload(stageDir, source, name) {
  const dir = join(stageDir, 'downloads');
  mkdirSync(dir, { recursive: true });
  cpSync(source, join(dir, name));
  const bytes = readFileSync(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, `${name}.sha256`), `${sha256}  ${name}\n`);
  return { sha256, bytes: bytes.length };
}

/** Copy the installer into the stage's downloads/ with a `sha256sum`-style checksum file. */
function stageDesktopInstaller(installer) {
  if (installer === undefined) return;
  const { sha256, bytes } = stageDownload(STAGE, installer, DESKTOP_INSTALLER_NAME);
  process.stdout.write(
    `\ndesktop installer: ${(bytes / (1024 * 1024)).toFixed(1)} MB, sha256 ${sha256}\n`,
  );
}

/**
 * The AI connector's local stdio bridge, served at /downloads/tmanage-mcp.tgz by the API
 * (ai-connector-fallbacks.controller.ts reads `<bundle>/downloads/tmanage-mcp.tgz` by default, no
 * variable needed) and run with `npx -y https://<host>/downloads/tmanage-mcp.tgz`. It is
 * `pnpm pack` of apps/mcp-server: the `tmanage-mcp` bin, dist/ and README, with its registry
 * dependencies declared so npx installs them. Platform-independent, so every build ships it.
 */
export const MCP_BRIDGE_TARBALL_NAME = 'tmanage-mcp.tgz';

/** `pnpm pack`'s file name for a package name and version (`@scope/name` -> `scope-name`). */
export function packTarballName(name, version) {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** Pack @tmanage/mcp-server into a fresh `destDir` and return the tarball's path. */
export function packMcpBridge(destDir, runner = run) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  runner('pnpm', ['--filter', '@tmanage/mcp-server', 'pack', '--pack-destination', destDir]);
  const { name, version } = JSON.parse(
    readFileSync(join(REPO, 'apps/mcp-server/package.json'), 'utf8'),
  );
  const packed = join(destDir, packTarballName(name, version));
  if (!existsSync(packed)) throw new Error(`pnpm pack did not write ${packed}`);
  return packed;
}

function stageMcpBridge(tarball) {
  const { sha256, bytes } = stageDownload(STAGE, tarball, MCP_BRIDGE_TARBALL_NAME);
  process.stdout.write(
    `\nAI connector bridge: ${(bytes / 1024).toFixed(0)} KB, sha256 ${sha256}\n`,
  );
}

/**
 * The apps/server modules shipped next to server.mjs: the entry's whole relative-import closure,
 * plus web-socket-preload.mjs, which server.mjs passes to the web child by path (`--import`).
 * A module missing here fails boot on Hostinger (cache-headers.mjs 2026-10-23, job-alerts.mjs
 * 2026-10-25); server-files.test.mjs derives the closure from the sources and checks this list.
 * web-transport.mjs and web-socket-preload.mjs carry the listen-first boot and the private
 * socket to the web child (Hostinger refuses loopback TCP between the app's own processes).
 */
export const SERVER_FILES = Object.freeze([
  'database-env.mjs',
  'boot-guards.mjs',
  'production-env.mjs',
  'web-transport.mjs',
  'web-socket-preload.mjs',
  // server.mjs imports the web child's restart backoff from here; missing it, boot fails.
  'web-restart.mjs',
  // server.mjs and web-transport.mjs import the CDN cache policy from here; missing it, boot fails.
  'cache-headers.mjs',
  // server.mjs imports the in-process sweep scheduler from here; missing it, boot fails.
  'scheduled-sweeps.mjs',
  // server.mjs imports the job alerts from here; missing it, boot fails.
  'job-alerts.mjs',
  // server.mjs imports the process crash alerts (51-13a) from here; missing it, boot fails.
  'process-alerts.mjs',
  // server.mjs imports the attached realtime socket (H2) from here; missing it, boot fails.
  'realtime-inprocess.mjs',
  // server.mjs imports the migration shutdown gate from here; missing it, boot fails.
  'migration-shutdown.mjs',
  // server.mjs imports the CSP violation report receiver (56-01) from here; missing it, boot fails.
  'csp-report.mjs',
  // server.mjs imports the security.txt handler (56-17) from here; missing it, boot fails.
  'security-txt.mjs',
  // server.mjs imports the page rate limit (FIX6) from here; missing it, boot fails.
  'page-limit.mjs',
  // server.mjs imports the Platform admin page gate (PLATFORMFIX) from here; missing it, boot fails.
  'platform-gate.mjs',
  // server.mjs imports the leader lease loop (DC-3 / RT-3) from here; missing it, boot fails.
  'leadership.mjs',
  // server.mjs imports the public server's timeouts (ST-3) from here; missing it, boot fails.
  'server-timeouts.mjs',
]);

function assemble() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  // The entry.
  cpSync(join(REPO, 'apps/server/server.mjs'), join(STAGE, 'server.mjs'));
  for (const file of SERVER_FILES) {
    cpSync(join(REPO, 'apps/server', file), join(STAGE, file));
  }

  // The vendored private packages (dist + manifest + the run-time trees in VENDOR_EXTRA_TREES).
  for (const pkg of VENDOR_PKGS) {
    const dest = join(STAGE, 'vendor/@tmanage', pkg);
    mkdirSync(dest, { recursive: true });
    copyTree(join(REPO, `${pkgDir(pkg)}/dist`), join(dest, 'dist'));
    for (const tree of VENDOR_EXTRA_TREES[pkg] ?? []) {
      copyTree(join(REPO, pkgDir(pkg), tree), join(dest, tree));
    }
    writeFileSync(
      join(dest, 'package.json'),
      `${JSON.stringify(vendorManifest(pkgDir(pkg)), null, 2)}\n`,
    );
  }

  // The web application: the production build (minus the rebuildable `cache/` and the
  // `dev/` server artifacts a prior `next dev` leaves behind — neither is served in
  // production) and the static assets.
  const web = join(STAGE, 'web');
  mkdirSync(web, { recursive: true });
  copyTree(join(REPO, 'apps/web/.next'), join(web, '.next'), ['cache', 'dev']);
  if (existsSync(join(REPO, 'apps/web/public')))
    copyTree(join(REPO, 'apps/web/public'), join(web, 'public'));

  // Turbopack's production build keeps the preview-mode keys in prerender-manifest.json but does
  // not emit .next/server/preview-props.json, which the production server reads at startup.
  // Derive it so `next start` can boot against this build.
  const prerender = JSON.parse(readFileSync(join(web, '.next/prerender-manifest.json'), 'utf8'));
  writeFileSync(
    join(web, '.next/server/preview-props.json'),
    JSON.stringify(prerender.preview ?? {}),
  );
  cpSync(join(REPO, 'apps/web/package.json'), join(web, 'package.json'));

  // `next start` would load a next.config.ts through Next's native SWC, which Hostinger's glibc
  // is too old to run — so the bundle ships the config pre-converted to next.config.mjs (plain
  // Node loads it) together with every local module it imports, also as .mjs, and NO .ts config.
  // The modules are discovered from the config's own imports, so a new one cannot silently break
  // `next start`. (The config re-runs its NEXT_PUBLIC_* validation at startup, so server.mjs sets
  // those variables for the web child.)
  const ts = createRequire(join(REPO, 'apps/web/package.json'))('typescript');
  const converted = convertNextConfig({ ts, webDir: join(REPO, 'apps/web'), outDir: web });
  process.stdout.write(`\nnext.config converted for the bundle: ${converted.join(', ')}\n`);
  loadStagedNextConfig({ webDir: web });
  process.stdout.write('staged next.config.mjs loads as `next start` loads it\n');

  // The migrations the one process applies on start. The three-user grant script
  // (scripts/db/users.sql) is NOT shipped: Hostinger gives one database user, so it is inert
  // there, and the security review asked for it out of the bundle.
  copyTree(join(REPO, 'apps/api/migrations'), join(STAGE, 'migrations'));
  const pinned = pinnedMigrationProblems(join(STAGE, 'migrations'));
  if (pinned.length > 0) {
    throw new Error(`the bundle's applied migrations changed:\n  ${pinned.join('\n  ')}`);
  }

  // The root manifest npm installs on Hostinger. The private packages are file: links; the direct
  // registry dependencies are pinned to the EXACT versions the build resolved (so the installed
  // Next matches the one that produced .next); everything else arrives transitively from the
  // vendored manifests, also exact-pinned.
  const manifest = {
    name: 'tmanage-hostinger',
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=22.12.0 <23' },
    // Hostinger's Node.js build pipeline runs `npm install`, then the build script, then the
    // entry file. Everything is already built, so the build script only says so; NEXT_PUBLIC_*
    // were baked in at bundle build time (same-origin), so no panel variable needs a rebuild.
    scripts: {
      build: 'echo TManage bundle is prebuilt - nothing to build',
      start: 'node server.mjs',
    },
    dependencies: {
      ...Object.fromEntries(
        Object.entries(BUNDLE_DIRECT_DEPENDENCIES).map(([name, dir]) => [
          name,
          exactVersion(name, dir),
        ]),
      ),
      '@tmanage/api': 'file:./vendor/@tmanage/api',
      '@tmanage/config': 'file:./vendor/@tmanage/config',
      '@tmanage/contracts': 'file:./vendor/@tmanage/contracts',
      '@tmanage/domain': 'file:./vendor/@tmanage/domain',
      '@tmanage/mail': 'file:./vendor/@tmanage/mail',
      '@tmanage/mcp-server': 'file:./vendor/@tmanage/mcp-server',
      '@tmanage/storage': 'file:./vendor/@tmanage/storage',
      '@tmanage/ui': 'file:./vendor/@tmanage/ui',
      '@tmanage/worker': 'file:./vendor/@tmanage/worker',
    },
  };
  // npm ignores the root `pnpm.overrides`, so the transitive security pins are carried over as npm
  // `overrides` (selector keys translated, not dropped) for every package of the production tree
  // pnpm-lock.yaml resolved, plus exact pins that make npm reproduce that tree (NV08, run 2).
  const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const pnpmSet = pnpmProductionSet(
    parsePnpmLock(readFileSync(join(REPO, 'pnpm-lock.yaml'), 'utf8')),
    VENDOR_PKGS.map(pkgDir),
    BUNDLE_DIRECT_DEPENDENCIES,
  );
  const overrides = bundleOverrides(rootPkg, pnpmSet, Object.keys(BUNDLE_DIRECT_DEPENDENCIES));
  if (Object.keys(overrides).length > 0) manifest.overrides = overrides;
  writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Hostinger's build sandbox refuses symlinks (npm install failed with EACCES on
  // `symlink ../../vendor/@tmanage/worker`). `install-links` makes npm COPY the file: packages
  // into node_modules instead of linking them, and `bin-links=false` skips the node_modules/.bin
  // links (server.mjs starts Next via require.resolve('next/dist/bin/next'), not .bin/next).
  // NV08: the same .npmrc plus ignore-scripts, and a lockfile that pins the transitive tree.
  const pins = stageInstallPins(STAGE, run, { pnpmSet, rootOverrides: rootPkg.pnpm?.overrides });
  process.stdout.write(
    `\nbundle lockfile: ${pins.packages} packages pinned, same tree as pnpm-lock.yaml, override floors and npm audit passed (reviewed allowlist: ${AUDIT_ADVISORY_ALLOWLIST.map((a) => `${a.id} ${a.package}`).join(', ') || 'none'}), install scripts off\n`,
  );

  // The owner's guide, the settings template and the secret generator travel with the bundle,
  // so the ZIP alone is enough to follow DEPLOY-HOSTINGER.md. None of them holds a secret.
  for (const file of ['DEPLOY-HOSTINGER.md', '.env.example', 'generate-secret.mjs']) {
    cpSync(join(HERE, file), join(STAGE, file));
  }

  writeFileSync(
    join(STAGE, 'START-HERE.txt'),
    [
      'TManage — Hostinger Node.js app bundle',
      '',
      'App type: other (or express)   Node: 22   Package manager: npm',
      'Root directory: ./   Build script: npm run build (no-op)   Entry file: server.mjs',
      '',
      'Database variables (DATABASE_URL, DB_*) are set by Hostinger; add the other settings',
      'from .env.example, then deploy. Full steps: DEPLOY-HOSTINGER.md.',
      '',
    ].join('\n'),
  );
}

function pkgDir(pkg) {
  if (pkg === 'api' || pkg === 'worker' || pkg === 'mcp-server') return `apps/${pkg}`;
  return `packages/${pkg}`;
}

function zip() {
  rmSync(ZIP, { force: true });
  if (process.platform === 'win32') {
    // Windows PowerShell 5.1's Compress-Archive stores entry names with backslashes
    // (`web\src\lib\...`), which a Linux unzip need not treat as folders. The bsdtar that ships
    // with Windows 10+ writes a standard zip with forward-slash names.
    // By full path: under Git Bash a bare `tar` is GNU tar, which cannot write zip.
    const bsdtar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    run(bsdtar, ['-a', '-c', '-f', ZIP, '-C', STAGE, ...readdirSync(STAGE)]);
  } else {
    run('bash', ['-c', `cd '${STAGE}' && zip -qr '${ZIP}' .`]);
  }
}

// Build only when run as a script; importing this module (the unit test) only loads the helpers.
// (Paths compared case-insensitively on Windows, where `node c:\...` and `C:\...` are one file.)
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  mkdirSync(OUT, { recursive: true });
  refuseDirtyCheckout();
  const startedAtMs = Date.now();
  buildArtifacts();
  verifyWebBuild(startedAtMs);
  const installer = buildDesktopInstaller();
  const bridge = packMcpBridge(join(OUT, 'mcp-bridge'));
  assemble();
  stageDesktopInstaller(installer);
  stageMcpBridge(bridge);
  zip();

  const sizeMb = (readFileSync(ZIP).length / (1024 * 1024)).toFixed(1);
  process.stdout.write(
    `\nBundle ready: ${ZIP}\n  size: ${sizeMb} MB\n  startup file: server.mjs\n`,
  );
}
