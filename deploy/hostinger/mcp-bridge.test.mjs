// Run: node --test deploy/hostinger/mcp-bridge.test.mjs
//
// The AI connector page tells users to run `npx -y https://<host>/downloads/tmanage-mcp.tgz`. The
// deploy build packs @tmanage/mcp-server into the bundle's downloads/ (build.mjs packMcpBridge +
// stageDownload) and the API serves that file by default. Live answered 503 bridge_unavailable
// because no build ever produced it. This packs the real package, stages it the way the build
// does, and checks the tarball is something npx can run: a bin with a shebang, the built dist,
// and every bare import declared as a dependency (nothing workspace-only).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  MCP_BRIDGE_TARBALL_NAME,
  packMcpBridge,
  packTarballName,
  stageDownload,
} from './build.mjs';

const work = mkdtempSync(join(tmpdir(), 'tmanage-mcp-bridge-'));
after(() => rmSync(work, { recursive: true, force: true }));

test('pnpm pack file names fold the scope in', () => {
  assert.equal(packTarballName('@tmanage/mcp-server', '0.1.0'), 'tmanage-mcp-server-0.1.0.tgz');
  assert.equal(packTarballName('plain', '1.2.3'), 'plain-1.2.3.tgz');
});

test('the build stages the packed bridge as downloads/tmanage-mcp.tgz with its sha256', () => {
  const packed = packMcpBridge(join(work, 'pack'));
  const stage = join(work, 'stage');
  const { sha256, bytes } = stageDownload(stage, packed, MCP_BRIDGE_TARBALL_NAME);

  const staged = join(stage, 'downloads', MCP_BRIDGE_TARBALL_NAME);
  assert.ok(existsSync(staged), 'downloads/tmanage-mcp.tgz is in the bundle');
  const tgz = readFileSync(staged);
  assert.equal(tgz.length, bytes);
  assert.equal(createHash('sha256').update(tgz).digest('hex'), sha256);
  assert.equal(
    readFileSync(join(stage, 'downloads', `${MCP_BRIDGE_TARBALL_NAME}.sha256`), 'utf8'),
    `${sha256}  ${MCP_BRIDGE_TARBALL_NAME}\n`,
  );

  // Unpack it (relative names: Windows' bsdtar and GNU tar both accept them).
  const unpacked = join(work, 'unpacked');
  cpSync(staged, join(unpacked, 'bridge.tgz'));
  const tar = spawnSync('tar', ['-xzf', 'bridge.tgz'], { cwd: unpacked, encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const pkgDir = join(unpacked, 'package');
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

  // npx runs the package's only bin.
  assert.deepEqual(Object.keys(manifest.bin ?? {}), ['tmanage-mcp']);
  const binPath = join(pkgDir, manifest.bin['tmanage-mcp']);
  assert.ok(existsSync(binPath), `bin target ${manifest.bin['tmanage-mcp']} is in the tarball`);
  assert.match(readFileSync(binPath, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  assert.equal(manifest.type, 'module');

  // Registry dependencies only: npx installs them from npm.
  const deps = manifest.dependencies ?? {};
  for (const [name, spec] of Object.entries(deps)) {
    assert.doesNotMatch(String(spec), /^(workspace|file|link):/, `${name}@${spec}`);
  }

  // Every bare import the shipped code makes is a declared dependency (or a Node builtin).
  const builtins = new Set(builtinModules);
  const files = readdirSync(join(pkgDir, 'dist'), { recursive: true }).filter((f) =>
    String(f).endsWith('.js'),
  );
  assert.ok(files.length > 0, 'dist/ ships compiled JavaScript');
  for (const file of files) {
    const source = readFileSync(join(pkgDir, 'dist', String(file)), 'utf8');
    for (const [, spec] of source.matchAll(/\bfrom\s+['"]([^'"./][^'"]*)['"]/g)) {
      if (spec.startsWith('node:') || builtins.has(spec)) continue;
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      assert.ok(pkg in deps, `${file} imports ${spec}, which the tarball does not declare`);
    }
  }
  // No test files or sources ride along.
  assert.ok(!files.some((f) => String(f).includes('.test.')), 'no compiled tests in dist/');
});
