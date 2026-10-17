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
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const OUT = join(HERE, 'out');
const STAGE = join(OUT, 'stage');
const ZIP = join(OUT, 'tmanage-hostinger.zip');

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
const VENDOR_PKGS = ['config', 'domain', 'mail', 'storage', 'contracts', 'ui', 'worker', 'api'];

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

function assemble() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  // The entry.
  cpSync(join(REPO, 'apps/server/server.mjs'), join(STAGE, 'server.mjs'));
  for (const file of ['database-env.mjs', 'boot-guards.mjs', 'production-env.mjs']) {
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

  // `next start` loads next.config.ts at startup; it imports ./src/lib/public-config, which Next
  // compiles the config against but does NOT transpile — so ship that one module precompiled to
  // JS beside a src/lib it can `require`. (The config re-runs its NEXT_PUBLIC_* validation at
  // startup, so server.mjs sets those variables for the web child.)
  cpSync(join(REPO, 'apps/web/next.config.ts'), join(web, 'next.config.ts'));
  mkdirSync(join(web, 'src/lib'), { recursive: true });
  run('pnpm', [
    'exec',
    'tsc',
    join(REPO, 'apps/web/src/lib/public-config.ts'),
    '--outDir',
    join(web, 'src/lib'),
    '--target',
    'es2022',
    '--module',
    'esnext',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
  ]);

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
      '@tmanage/storage': 'file:./vendor/@tmanage/storage',
      '@tmanage/ui': 'file:./vendor/@tmanage/ui',
      '@tmanage/worker': 'file:./vendor/@tmanage/worker',
    },
  };
  writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

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
  return pkg === 'api' ? 'apps/api' : pkg === 'worker' ? 'apps/worker' : `packages/${pkg}`;
}

function zip() {
  rmSync(ZIP, { force: true });
  if (process.platform === 'win32') {
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -Force`,
    ]);
  } else {
    run('bash', ['-c', `cd '${STAGE}' && zip -qr '${ZIP}' .`]);
  }
}

mkdirSync(OUT, { recursive: true });
buildArtifacts();
assemble();
zip();

const sizeMb = (readFileSync(ZIP).length / (1024 * 1024)).toFixed(1);
process.stdout.write(`\nBundle ready: ${ZIP}\n  size: ${sizeMb} MB\n  startup file: server.mjs\n`);
