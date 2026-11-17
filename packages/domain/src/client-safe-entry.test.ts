import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The package index (and every subpath the web app may import) is bundled into the browser.
 * One `node:` import anywhere in its import graph makes the bundler ship Node stand-ins
 * (crypto-browserify, util, stream: about 0.5 MB), and one of them runs
 * `Function("return function*() {}")`, which the Trusted Types policy refuses. Server-only
 * modules live behind their own subpaths (field-cipher, zatca-sign, realtime-ticket) and the
 * web app is linted away from them (eslint.config.js, web boundary block).
 */
const SRC = dirname(fileURLToPath(import.meta.url));
const CLIENT_ENTRIES = ['index.ts', 'contact/contact-addresses.ts'];
const SERVER_ONLY_SUBPATHS = ['./field-cipher', './realtime-ticket', './zatca-sign'];

const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith('_')));
const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const NODE_GLOBAL_RE =
  /\bBuffer\.(?:from|alloc|concat|isBuffer)\b|\bprocess\.(?:env|versions|nextTick)\b/;

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every Node reach found in the import graph of `entry`, as "file -> specifier". */
function nodeReaches(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(SRC.length + 1).replaceAll('\\', '/');
    if (NODE_GLOBAL_RE.test(code)) found.push(`${rel} -> Node global`);
    for (const match of code.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? '';
      if (spec.startsWith('.')) {
        queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      } else if (spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0] ?? '')) {
        found.push(`${rel} -> ${spec}`);
      }
    }
  }
  return found;
}

describe('client-safe entries of @tmanage/domain', () => {
  it.each(CLIENT_ENTRIES)('%s reaches no Node built-in', (entry) => {
    expect(nodeReaches(entry)).toEqual([]);
  });

  it('server-only modules stay on their own subpaths and are found by the walk', () => {
    const pkg = JSON.parse(readFileSync(resolve(SRC, '../package.json'), 'utf8')) as {
      exports: Record<string, { default: string }>;
    };
    for (const subpath of SERVER_ONLY_SUBPATHS) {
      const target = pkg.exports[subpath]?.default ?? '';
      const source = target.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts');
      expect(nodeReaches(source).length, subpath).toBeGreaterThan(0);
    }
  });
});
