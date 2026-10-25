// Run: node --test deploy/hostinger/server-files.test.mjs
//
// The bundle ships apps/server/server.mjs plus the list in build.mjs (SERVER_FILES). A module the
// entry imports but the list leaves out boots fine locally and dies on Hostinger with
// ERR_MODULE_NOT_FOUND — it happened with cache-headers.mjs (2026-10-23) and job-alerts.mjs
// (2026-10-25). This derives what the entry really needs from the sources and checks the list.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SERVER_FILES } from './build.mjs';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/server');

/** Same-directory relative specifiers a module loads: static, side-effect, re-export, dynamic. */
function localImports(source) {
  const patterns = [
    /\bfrom\s+['"](\.\/[^'"]+)['"]/g, // import { x } from './x.mjs' / export { x } from './x.mjs'
    /\bimport\s+['"](\.\/[^'"]+)['"]/g, // import './x.mjs'
    /\bimport\(\s*['"](\.\/[^'"]+)['"]\s*\)/g, // await import('./x.mjs')
  ];
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1].slice(2)));
}

/** Modules handed to a child process by path from the entry's own directory (`--import`). */
function pathLoaded(source) {
  return [...source.matchAll(/\bresolve\(\s*ROOT\s*,\s*['"]([^'"/]+\.mjs)['"]\s*\)/g)].map(
    (m) => m[1],
  );
}

/** Every apps/server file server.mjs needs at run time, transitively. */
function serverClosure() {
  const needed = new Set();
  const queue = ['server.mjs'];
  while (queue.length > 0) {
    const file = queue.shift();
    const source = readFileSync(join(SERVER_DIR, file), 'utf8');
    const next = [...localImports(source), ...(file === 'server.mjs' ? pathLoaded(source) : [])];
    for (const dep of next) {
      assert.ok(
        !dep.includes('/'),
        `${file} imports '${dep}' from a subfolder the bundle flattens`,
      );
      if (needed.has(dep)) continue;
      needed.add(dep);
      queue.push(dep);
    }
  }
  return needed;
}

test('every module server.mjs loads, transitively, is shipped', () => {
  const closure = serverClosure();
  const missing = [...closure].filter((file) => !SERVER_FILES.includes(file)).sort();
  assert.deepEqual(missing, [], `build.mjs SERVER_FILES is missing: ${missing.join(', ')}`);
});

test('the closure finds the known edges (guards the parser, not just the list)', () => {
  const closure = serverClosure();
  for (const file of [
    'production-env.mjs', // import './production-env.mjs' (side-effect, first)
    'boot-guards.mjs', // via production-env.mjs and web-transport.mjs
    'cache-headers.mjs', // via server.mjs and web-transport.mjs
    'job-alerts.mjs',
    'web-transport.mjs', // multi-line import list
    'web-socket-preload.mjs', // passed by path, never imported
  ]) {
    assert.ok(closure.has(file), `closure lost ${file}`);
  }
});

test('every listed file exists and is a runtime module, not a test', () => {
  for (const file of SERVER_FILES) {
    assert.ok(existsSync(join(SERVER_DIR, file)), `${file} is listed but not in apps/server`);
    assert.ok(!/\.test\.mjs$/.test(file), `${file} is a test file`);
  }
  assert.equal(new Set(SERVER_FILES).size, SERVER_FILES.length, 'SERVER_FILES has duplicates');
  assert.ok(!SERVER_FILES.includes('server.mjs'), 'server.mjs is copied as the entry already');
});

test('the parser reads every import form', () => {
  const source = [
    "import './a.mjs';",
    "import { b } from './b.mjs';",
    'import {\n  c1,\n  c2,\n} from "./c.mjs";',
    "export { d } from './d.mjs';",
    "const { e } = await import('./e.mjs');",
    "import x from 'node:fs';",
    "import y from '@tmanage/config';",
  ].join('\n');
  assert.deepEqual(localImports(source).sort(), ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs']);
  assert.deepEqual(pathLoaded("resolve(ROOT, 'p.mjs')"), ['p.mjs']);
});
