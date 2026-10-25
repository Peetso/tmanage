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

import { npmOverridesFromRoot } from './bundle-overrides.mjs';

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
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replaceAll('&amp;', '&');
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

function run(cmd, args, env) {
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  const result = spawnSync(cmd, args, {
    cwd: REPO,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
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

function buildArtifacts() {
  run('pnpm', ['build:packages']);
  run('pnpm', ['--filter', '@tmanage/worker', 'build']);
  run('pnpm', ['--filter', '@tmanage/api', 'build']);
  // The web build inlines NEXT_PUBLIC_* at compile time: same-origin topology, the documented
  // default cookie name, and a loopback proxy target the runtime never actually dials (the
  // single process answers /v1 before Next's rewrite would). The project's own build script
  // (Turbopack, the Next 16 default) is used as-is; the bundle serves that build with
  // `next start`, which is the server it is made for.
  run('pnpm', ['--filter', '@tmanage/web', 'build'], {
    NODE_ENV: 'production',
    NEXT_PUBLIC_API_BASE_URL: 'same-origin',
    NEXT_PUBLIC_SESSION_COOKIE_NAME: 'tmanage_session',
    API_PROXY_TARGET: 'http://127.0.0.1:3000',
  });
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
]);

function assemble() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  // The entry.
  cpSync(join(REPO, 'apps/server/server.mjs'), join(STAGE, 'server.mjs'));
  for (const file of SERVER_FILES) {
    cpSync(join(REPO, 'apps/server', file), join(STAGE, file));
  }

  // The vendored private packages (dist + manifest; ui also ships its raw style sources).
  for (const pkg of VENDOR_PKGS) {
    const dest = join(STAGE, 'vendor/@tmanage', pkg);
    mkdirSync(dest, { recursive: true });
    copyTree(join(REPO, `${pkgDir(pkg)}/dist`), join(dest, 'dist'));
    if (pkg === 'ui') copyTree(join(REPO, 'packages/ui/src/styles'), join(dest, 'src/styles'));
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

  // The migrations the one process applies on start. The three-user grant script
  // (scripts/db/users.sql) is NOT shipped: Hostinger gives one database user, so it is inert
  // there, and the security review asked for it out of the bundle.
  copyTree(join(REPO, 'apps/api/migrations'), join(STAGE, 'migrations'));

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
      '@tanstack/react-query': exactVersion('@tanstack/react-query', 'apps/web'),
      next: exactVersion('next', 'apps/web'),
      react: exactVersion('react', 'apps/web'),
      'react-dom': exactVersion('react-dom', 'apps/web'),
      'reflect-metadata': exactVersion('reflect-metadata', 'apps/api'),
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
  // `overrides` — runtime packages only; dev-only pins never reach the bundle's install.
  const rootPkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const overrides = npmOverridesFromRoot(rootPkg, [
    'fastify',
    'fast-uri',
    'sharp',
    'source-map-js',
    'nodemailer',
    '@nestjs/platform-fastify',
  ]);
  if (Object.keys(overrides).length > 0) manifest.overrides = overrides;
  writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Hostinger's build sandbox refuses symlinks (npm install failed with EACCES on
  // `symlink ../../vendor/@tmanage/worker`). `install-links` makes npm COPY the file: packages
  // into node_modules instead of linking them, and `bin-links=false` skips the node_modules/.bin
  // links (server.mjs starts Next via require.resolve('next/dist/bin/next'), not .bin/next).
  writeFileSync(join(STAGE, '.npmrc'), 'install-links=true\nbin-links=false\n');

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
  assemble();
  zip();

  const sizeMb = (readFileSync(ZIP).length / (1024 * 1024)).toFixed(1);
  process.stdout.write(
    `\nBundle ready: ${ZIP}\n  size: ${sizeMb} MB\n  startup file: server.mjs\n`,
  );
}
