// Run: node --test deploy/hostinger/next-config-mjs.test.mjs
//
// The bundle must ship next.config.mjs (loaded by plain Node), never next.config.ts (which needs
// Next's native SWC — too new for Hostinger's glibc). These tests convert the REAL repository
// config with the real TypeScript compiler and load the result with plain `import()`.
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { convertNextConfig } from './build.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = join(REPO, 'apps/web');
const ts = createRequire(join(WEB, 'package.json'))('typescript');

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'tmanage-next-config-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function filesUnder(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

test('converts the repo config and every module it imports to .mjs, and writes no .ts', () => {
  const out = tempDir();
  const written = convertNextConfig({ ts, webDir: WEB, outDir: out });

  assert.equal(written[0], 'next.config.mjs');
  assert.ok(written.includes('src/lib/public-config.mjs'), written.join(', '));
  assert.ok(written.includes('src/lib/static-headers.mjs'), written.join(', '));
  assert.deepEqual(filesUnder(out).sort(), [...written].sort());
  assert.ok(!existsSync(join(out, 'next.config.ts')));
  assert.ok(filesUnder(out).every((file) => file.endsWith('.mjs')));

  const config = readFileSync(join(out, 'next.config.mjs'), 'utf8');
  assert.match(config, /from '\.\/src\/lib\/public-config\.mjs'/);
  assert.match(config, /from '\.\/src\/lib\/static-headers\.mjs'/);
  // The type-only `import type { NextConfig } from 'next'` is gone: nothing left for SWC to do.
  assert.doesNotMatch(config, /from 'next'/);
  assert.doesNotMatch(config, /:\s*NextConfig\b/);
});

test('the converted config loads with plain Node and keeps the security headers', async () => {
  const out = tempDir();
  convertNextConfig({ ts, webDir: WEB, outDir: out });

  const saved = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'production',
    NEXT_PUBLIC_API_BASE_URL: 'same-origin',
    NEXT_PUBLIC_SESSION_COOKIE_NAME: 'tmanage_session',
    API_PROXY_TARGET: 'http://127.0.0.1:3000',
  });
  try {
    const { default: config } = await import(pathToFileURL(join(out, 'next.config.mjs')).href);
    assert.equal(config.poweredByHeader, false);
    assert.equal(config.reactStrictMode, true);
    assert.deepEqual(config.transpilePackages, ['@tmanage/ui']);

    const rewrites = await config.rewrites();
    assert.ok(
      rewrites.some(
        (rule) => rule.source.startsWith('/v1') && rule.destination.includes('127.0.0.1:3000'),
      ),
      JSON.stringify(rewrites),
    );

    const headers = await config.headers();
    const catchAll = headers.find((rule) => rule.source === '/:path*');
    const keys = catchAll.headers.map((header) => header.key);
    for (const key of ['X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
      assert.ok(keys.includes(key), `missing ${key}`);
    }
    // X-Frame-Options left the catch-all in 52-20 (the embeddable public form at /f/<id> is
    // framed); every other page still gets DENY from its own rule.
    const frameRule = headers.find((rule) =>
      rule.headers.some((h) => h.key === 'X-Frame-Options' && h.value === 'DENY'),
    );
    assert.ok(frameRule, 'missing X-Frame-Options DENY');
    assert.ok(new RegExp(`^${frameRule.source}$`).test('/projects'), frameRule.source);
    assert.ok(!new RegExp(`^${frameRule.source}$`).test('/f/abc'), frameRule.source);
    assert.ok(headers.length > 1, 'static asset Cache-Control rules missing');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('follows a module the config imports transitively, and rewrites its specifiers', () => {
  const web = tempDir();
  mkdirSync(join(web, 'src/lib'), { recursive: true });
  writeFileSync(
    join(web, 'next.config.ts'),
    "import type { NextConfig } from 'next';\nimport { a } from './src/lib/a';\nconst c: NextConfig = { env: { A: a } };\nexport default c;\n",
  );
  writeFileSync(
    join(web, 'src/lib/a.ts'),
    "import { b } from './b';\nexport const a: string = b;\n",
  );
  writeFileSync(join(web, 'src/lib/b.ts'), "export const b: string = 'b';\n");
  const out = tempDir();

  const written = convertNextConfig({ ts, webDir: web, outDir: out });

  assert.deepEqual(written, ['next.config.mjs', 'src/lib/a.mjs', 'src/lib/b.mjs']);
  assert.match(readFileSync(join(out, 'src/lib/a.mjs'), 'utf8'), /from '\.\/b\.mjs'/);
});

test('fails loudly when the config imports a local module that is not a .ts file', () => {
  const web = tempDir();
  writeFileSync(
    join(web, 'next.config.ts'),
    "import { x } from './missing';\nexport default { x };\n",
  );

  assert.throws(
    () => convertNextConfig({ ts, webDir: web, outDir: tempDir() }),
    /imports \.\/missing/,
  );
});
